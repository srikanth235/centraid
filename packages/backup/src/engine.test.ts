// governance: allow-repo-hygiene file-size-limit (#408) the engine's behavior suite — snapshot/restore/verify roundtrips plus the /1 WAL+PITR+determinism cases all share the same provider/keyring/tempdir fixtures; splitting by topic would duplicate the fixture plumbing in every shard
import { createHash } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, test } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";

import { ALGO_STORE, ALGO_ZSTD, unframeChunkPayload } from "./compress.js";
import {
  activeMasterKey,
  chunkId,
  createKeyring,
  decrypt,
  deriveDataKey,
  deriveDedupKey,
} from "./crypto.js";
import type { Keyring } from "./crypto.js";
import { createSnapshot, restoreSnapshot, verifySnapshot } from "./engine.js";
import type { SourceEntry } from "./engine.js";
import { LocalBackupProvider } from "./local-provider.js";
import {
  openManifest,
  READABLE_SNAPSHOT_FORMATS,
  SNAPSHOT_FORMAT_V2,
} from "./manifest.js";
import type { ObjectStore } from "./object-store.js";
import { partBuffer } from "./parts.js";
import type { BackupProvider, StoreClass } from "./provider.js";

/** Incremental put ceiling: new manifest + re-chunked 3 MiB vault.db. All else zero. */
const MAX_INCREMENTAL_PUTS = 3;
const CURRENT = {
  gatewayVersion: "0.1.0",
  vaultUserVersion: "1",
  ontologyVersion: "1.2",
};
const APP_META = {
  gatewayVersion: "0.1.0",
  vaultUserVersion: "1",
  ontologyVersion: "1.2",
  sourceInstanceId: "test-instance",
};

class CountingObjectStore implements ObjectStore {
  putCount = 0;
  putKeys: string[] = [];
  constructor(private readonly inner: ObjectStore) {}
  async put(
    key: string,
    data: Uint8Array | AsyncIterable<Uint8Array>
  ): Promise<void> {
    this.putCount++;
    this.putKeys.push(key);
    await this.inner.put(key, data);
  }
  get(key: string): Promise<Uint8Array> {
    return this.inner.get(key);
  }
  getStream(key: string): AsyncIterable<Uint8Array> {
    return this.inner.getStream(key);
  }
  head(key: string): Promise<{ size: number } | null> {
    return this.inner.head(key);
  }
  list(prefix: string): AsyncIterable<{ key: string; size: number }> {
    return this.inner.list(prefix);
  }
  delete(key: string): Promise<void> {
    return this.inner.delete(key);
  }
}

/* oxlint-disable max-classes-per-file -- (#354) the two spies are small, colocated
   test-only wrappers around one seam (ObjectStore + BackupProvider). */
class SpyProvider implements BackupProvider {
  lastStore: CountingObjectStore | undefined;
  constructor(private readonly inner: BackupProvider) {}
  capabilities() {
    return this.inner.capabilities();
  }
  createTarget(opts: { label: string }) {
    return this.inner.createTarget(opts);
  }
  deleteTarget(targetId: string) {
    return this.inner.deleteTarget(targetId);
  }
  undeleteTarget(targetId: string) {
    return this.inner.undeleteTarget(targetId);
  }
  purgeTarget(targetId: string) {
    return this.inner.purgeTarget(targetId);
  }
  async openDataPlane(
    targetId: string,
    store: StoreClass,
    mode: "read" | "read-write"
  ) {
    const objStore = new CountingObjectStore(
      await this.inner.openDataPlane(targetId, store, mode)
    );
    if (mode === "read-write") this.lastStore = objStore;
    return objStore;
  }
  registerSnapshot(
    targetId: string,
    reg: Parameters<BackupProvider["registerSnapshot"]>[1]
  ) {
    return this.inner.registerSnapshot(targetId, reg);
  }
  listSnapshots(targetId: string, opts?: { includePruned?: boolean }) {
    return this.inner.listSnapshots(targetId, opts);
  }
  getSnapshot(targetId: string, seq: number) {
    return this.inner.getSnapshot(targetId, seq);
  }
  getTarget(targetId: string) {
    return this.inner.getTarget(targetId);
  }
  usage(targetId: string) {
    return this.inner.usage(targetId);
  }
}

interface Fixture {
  provider: SpyProvider;
  targetId: string;
  keyring: Keyring;
  sourceDir: string;
  entries: SourceEntry[];
}

async function buildSourceTree(sourceDir: string): Promise<SourceEntry[]> {
  await fs.mkdir(path.join(sourceDir, "blobs", "ab"), { recursive: true });
  // /1 requires a complete, verifiable vault.db base.
  const vaultPath = path.join(sourceDir, "vault.db");
  const vault = new DatabaseSync(vaultPath);
  vault.exec(
    "PRAGMA journal_mode=DELETE; CREATE TABLE payload (bytes BLOB NOT NULL)"
  );
  vault
    .prepare("INSERT INTO payload (bytes) VALUES (?)")
    .run(Buffer.from(pseudoRandomBuffer(3 * 1024 * 1024, 1)));
  vault.close();
  await fs.writeFile(
    path.join(sourceDir, "blobs", "ab", "cdef"),
    pseudoRandomBuffer(50_000, 3)
  );
  await fs.writeFile(
    path.join(sourceDir, "apps.bundle"),
    pseudoRandomBuffer(20_000, 4)
  ); // fake git bundle
  await fs.writeFile(
    path.join(sourceDir, "seal.key"),
    pseudoRandomBuffer(32, 5)
  );

  return [
    {
      path: "vault.db",
      kind: "db",
      absolutePath: vaultPath,
      sha256: await fileSha256(vaultPath),
      walGeneration: "11".repeat(16),
      baseTickMs: 1_752_480_000_000,
    },
    {
      path: "blobs/ab/cdef",
      kind: "blob",
      absolutePath: path.join(sourceDir, "blobs", "ab", "cdef"),
    },
    {
      path: "apps.bundle",
      kind: "git-bundle",
      absolutePath: path.join(sourceDir, "apps.bundle"),
    },
    {
      path: "seal.key",
      kind: "seal-key",
      absolutePath: path.join(sourceDir, "seal.key"),
    },
  ];
}

function pseudoRandomBuffer(size: number, seed: number): Uint8Array {
  let x = seed >>> 0 || 1;
  const buf = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    buf[i] = x & 0xff;
  }
  return buf;
}

async function buildFixture(): Promise<Fixture> {
  const rootDir = await tempDir("backup-engine-provider-");
  const provider = new SpyProvider(new LocalBackupProvider({ rootDir }));
  const { targetId } = await provider.createTarget({ label: "engine-test" });
  const keyringDir = await tempDir("backup-engine-keyring-");
  const keyring = await createKeyring(path.join(keyringDir, "keyring.json"));
  const sourceDir = await tempDir("backup-engine-source-");
  const entries = await buildSourceTree(sourceDir);
  return { provider, targetId, keyring, sourceDir, entries };
}

describe("createSnapshot / restoreSnapshot roundtrip", () => {
  test("[law:backup-round-trip] restores byte-identical files and the directory tree, plus a quarantine marker", async () => {
    const { provider, targetId, keyring, entries } = await buildFixture();
    const row = await createSnapshot({
      provider,
      targetId,
      keyring,
      vaultId: "vault-1",
      entries,
      generation: 1,
      appMeta: APP_META,
    });
    expect(row).not.toBeNull();
    expect(row?.seq).toBe(1);

    const destDir = await tempDir("backup-engine-restore-");
    // restoreSnapshot requires a truly fresh dir.
    await fs.rm(destDir, { recursive: true, force: true });

    const result = await restoreSnapshot({
      provider,
      targetId,
      keyring,
      vaultId: "vault-1",
      destDir,
      current: CURRENT,
    });
    expect(result.seq).toBe(1);
    expect(result.entries.sort()).toStrictEqual(
      entries.map((e) => e.path).sort()
    );

    const restoredPairs = await Promise.all(
      entries.map(async (entry) => {
        const [original, restored] = await Promise.all([
          fs.readFile(entry.absolutePath),
          fs.readFile(path.join(destDir, ...entry.path.split("/"))),
        ]);
        return { original, restored };
      })
    );
    restoredPairs.forEach(({ original, restored }) =>
      expect(restored.equals(original)).toBe(true)
    );

    const marker = JSON.parse(
      await fs.readFile(path.join(destDir, "RESTORE_QUARANTINE.json"), "utf8")
    );
    expect(marker.sourceSeq).toBe(1);
    expect(marker.quarantine.sort()).toStrictEqual([
      "automations",
      "connections",
      "outbox",
    ]);
    expect(marker.restoredAt).toBeTypeOf("string");
  });

  test("[law:backup-incremental] incremental second snapshot after a 1-byte change uploads far fewer chunks than the first", async () => {
    const { provider, targetId, keyring, sourceDir, entries } =
      await buildFixture();
    await createSnapshot({
      provider,
      targetId,
      keyring,
      vaultId: "vault-1",
      entries,
      generation: 1,
      appMeta: APP_META,
    });
    const firstPutCount = provider.lastStore!.putCount;
    expect(firstPutCount).toBeGreaterThan(0);

    // Change one row; bump mtime so the fast path cannot reuse it.
    const dbPath = path.join(sourceDir, "vault.db");
    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE payload SET bytes = ?").run(
      Buffer.from(pseudoRandomBuffer(3 * 1024 * 1024, 99))
    );
    db.close();
    const future = new Date(Date.now() + 5000);
    await fs.utimes(dbPath, future, future);

    const updatedEntries = await Promise.all(
      entries.map(async (entry) =>
        entry.path === "vault.db"
          ? { ...entry, sha256: await fileSha256(dbPath) }
          : entry
      )
    );

    const row2 = await createSnapshot({
      provider,
      targetId,
      keyring,
      vaultId: "vault-1",
      entries: updatedEntries,
      generation: 1,
      appMeta: APP_META,
    });
    expect(row2).not.toBeNull();
    const secondPutCount = provider.lastStore!.putCount;
    expect(secondPutCount).toBeLessThan(firstPutCount);
    // `toBeLessThan` alone would still pass a full re-ship; ceiling is the law.
    expect(secondPutCount).toBeLessThanOrEqual(MAX_INCREMENTAL_PUTS);
    expect(
      provider.lastStore!.putKeys.filter((k) => k.startsWith("chunks/")).length
    ).toBeLessThanOrEqual(MAX_INCREMENTAL_PUTS - 1);
  });

  test("[law:backup-no-change] no-change run registers nothing (returns null, uploads only the previous unmodified state)", async () => {
    const { provider, targetId, keyring, entries } = await buildFixture();
    const row1 = await createSnapshot({
      provider,
      targetId,
      keyring,
      vaultId: "vault-1",
      entries,
      generation: 1,
      appMeta: APP_META,
    });
    expect(row1).not.toBeNull();

    const row2 = await createSnapshot({
      provider,
      targetId,
      keyring,
      vaultId: "vault-1",
      entries,
      generation: 1,
      appMeta: APP_META,
    });
    expect(row2).toBeNull();

    const rows = await provider.listSnapshots(targetId);
    expect(rows).toHaveLength(1);
  });

  test("[law:backup-restore-refusal] restoreSnapshot refuses a non-empty destDir", async () => {
    const { provider, targetId, keyring, entries } = await buildFixture();
    await createSnapshot({
      provider,
      targetId,
      keyring,
      vaultId: "vault-1",
      entries,
      generation: 1,
      appMeta: APP_META,
    });
    const destDir = await tempDir("backup-engine-nonempty-");
    await fs.writeFile(path.join(destDir, "preexisting.txt"), "hi");
    await expect(
      restoreSnapshot({
        provider,
        targetId,
        keyring,
        vaultId: "vault-1",
        destDir,
        current: CURRENT,
      })
    ).rejects.toThrow(/not empty/u);
  });

  test("[law:backup-restore-refusal] restoreSnapshot refuses a newer vaultUserVersion BEFORE fetching or materializing anything", async () => {
    const { provider, targetId, keyring, entries } = await buildFixture();
    await createSnapshot({
      provider,
      targetId,
      keyring,
      vaultId: "vault-1",
      entries,
      generation: 1,
      appMeta: APP_META,
    });
    // Manifest key that does not exist: a download would be a read error, not
    // the version-gate message. Format is current so only the version gate fires.
    await provider.registerSnapshot(targetId, {
      idempotencyKey: "doctored-newer-version",
      manifestKey: "manifests/does-not-exist-on-disk.json",
      manifestHash: "f".repeat(64),
      totalBytes: 1,
      objectCount: 1,
      generation: 2,
      format: SNAPSHOT_FORMAT_V2,
      appMeta: { ...APP_META, vaultUserVersion: "99999" },
    });
    const destDir = path.join(
      await tempDir("backup-engine-newver-"),
      "restore-dest"
    );
    await expect(
      restoreSnapshot({
        provider,
        targetId,
        keyring,
        vaultId: "vault-1",
        destDir,
        current: CURRENT,
      })
    ).rejects.toThrow(/newer/u);
    // Gate ran before any directory creation.
    expect(existsSync(destDir)).toBe(false);
  });

  test("[law:backup-restore-refusal] restoreSnapshot refuses an unknown format", async () => {
    const { provider, targetId, keyring, entries } = await buildFixture();
    await createSnapshot({
      provider,
      targetId,
      keyring,
      vaultId: "vault-1",
      entries,
      generation: 1,
      appMeta: APP_META,
    });
    // Future/unknown format via a second registration.
    await provider.registerSnapshot(targetId, {
      idempotencyKey: "bogus-format",
      manifestKey: "manifests/bogus.json",
      manifestHash: "f".repeat(64),
      totalBytes: 1,
      objectCount: 0,
      generation: 2,
      format: "centraid-snapshot/99",
      appMeta: APP_META,
    });
    const destDir = await tempDir("backup-engine-badfmt-");
    await fs.rm(destDir, { recursive: true, force: true });
    await expect(
      restoreSnapshot({
        provider,
        targetId,
        keyring,
        vaultId: "vault-1",
        destDir,
        current: CURRENT,
      })
    ).rejects.toThrow(/unknown format/u);
  });

  test("[law:backup-restore-refusal] restoreSnapshot rejects a snapshot whose manifest hash does not verify", async () => {
    const { provider, targetId, keyring, entries } = await buildFixture();
    const row = await createSnapshot({
      provider,
      targetId,
      keyring,
      vaultId: "vault-1",
      entries,
      generation: 1,
      appMeta: APP_META,
    });
    // Corrupt the stored manifest on disk.
    const store = await provider.openDataPlane(
      targetId,
      "backup",
      "read-write"
    );
    const bytes = await store.get(row!.manifestKey);
    const tampered = new Uint8Array(bytes);
    tampered[0]! ^= 0xff;
    await store.put(row!.manifestKey, tampered);
    const destDir = await tempDir("backup-engine-badhash-");
    await fs.rm(destDir, { recursive: true, force: true });
    await expect(
      restoreSnapshot({
        provider,
        targetId,
        keyring,
        vaultId: "vault-1",
        destDir,
        current: CURRENT,
      })
    ).rejects.toThrow(/hash mismatch/u);
  });
});

describe(verifySnapshot, () => {
  test("[law:backup-verify] detects a deliberately deleted chunk object", async () => {
    const { provider, targetId, keyring, entries } = await buildFixture();
    await createSnapshot({
      provider,
      targetId,
      keyring,
      vaultId: "vault-1",
      entries,
      generation: 1,
      appMeta: APP_META,
    });

    const store = await provider.openDataPlane(
      targetId,
      "backup",
      "read-write"
    );
    const listed: string[] = [];
    for await (const obj of store.list("chunks/")) listed.push(obj.key);
    expect(listed.length).toBeGreaterThan(0);
    await store.delete(listed[0]!);

    const result = await verifySnapshot({
      provider,
      targetId,
      keyring,
      vaultId: "vault-1",
      sampleCount: 20,
    });
    expect(result.missing).toContain(listed[0]!.slice("chunks/".length));
  });

  test("[law:backup-verify] detects a corrupted chunk object via the sample pass", async () => {
    const { provider, targetId, keyring, entries } = await buildFixture();
    await createSnapshot({
      provider,
      targetId,
      keyring,
      vaultId: "vault-1",
      entries,
      generation: 1,
      appMeta: APP_META,
    });

    const store = await provider.openDataPlane(
      targetId,
      "backup",
      "read-write"
    );
    const listed: string[] = [];
    for await (const obj of store.list("chunks/")) listed.push(obj.key);
    expect(listed.length).toBeGreaterThan(0);
    const target = listed[0]!;
    const bytes = await store.get(target);
    const tampered = new Uint8Array(bytes);
    tampered[tampered.length - 1]! ^= 0xff; // flip a tag byte
    await store.put(target, tampered);

    // sampleCount = all chunks so the corrupted one is sampled.
    const result = await verifySnapshot({
      provider,
      targetId,
      keyring,
      vaultId: "vault-1",
      sampleCount: 1000,
    });
    expect(result.corrupt).toContain(target.slice("chunks/".length));
  });

  test("[law:backup-verify] a clean snapshot verifies with no missing or corrupt objects", async () => {
    const { provider, targetId, keyring, entries } = await buildFixture();
    await createSnapshot({
      provider,
      targetId,
      keyring,
      vaultId: "vault-1",
      entries,
      generation: 1,
      appMeta: APP_META,
    });
    const result = await verifySnapshot({
      provider,
      targetId,
      keyring,
      vaultId: "vault-1",
      sampleCount: 20,
    });
    expect(result.missing).toStrictEqual([]);
    expect(result.corrupt).toStrictEqual([]);
    expect(result.checkedObjects).toBeGreaterThan(0);
  });
});

// /1 WAL (#408): anchored db entries, format gating, PITR, determinism.

/** A real, cleanly-closed SQLite database file (close checkpoints + deletes the WAL). */
function makeSqliteDbFile(filePath: string, vals: string[]): void {
  const conn = new DatabaseSync(filePath);
  conn.exec("PRAGMA journal_mode=WAL");
  conn.exec("CREATE TABLE rows (id INTEGER PRIMARY KEY, val TEXT NOT NULL)");
  const stmt = conn.prepare("INSERT INTO rows (val) VALUES (?)");
  for (const v of vals) stmt.run(v);
  conn.close();
}

function readSqliteRows(filePath: string): string[] {
  const conn = new DatabaseSync(filePath);
  try {
    return (
      conn.prepare("SELECT val FROM rows ORDER BY id").all() as {
        val: string;
      }[]
    ).map((r) => r.val);
  } finally {
    conn.close();
  }
}

async function fileSha256(filePath: string): Promise<string> {
  return createHash("sha256")
    .update(await fs.readFile(filePath))
    .digest("hex");
}

describe("/1 snapshots: db entries carry sha256 + walGeneration + baseTickMs", () => {
  const GEN_VAULT = "11".repeat(16);
  const BASE_TICK = 1752480000000;

  async function buildSqliteFixture(): Promise<
    Fixture & { genByPath: Map<string, string> }
  > {
    const rootDir = await tempDir("backup-engine-provider-");
    const provider = new SpyProvider(new LocalBackupProvider({ rootDir }));
    const { targetId } = await provider.createTarget({
      label: "engine-v2-test",
    });
    const keyringDir = await tempDir("backup-engine-keyring-");
    const keyring = await createKeyring(path.join(keyringDir, "keyring.json"));
    const sourceDir = await tempDir("backup-engine-source-");

    makeSqliteDbFile(path.join(sourceDir, "vault.db"), ["v1", "v2", "v3"]);
    // Last close checkpoints and deletes the WAL — the state the shipper snapshots.
    await expect(
      fs.access(path.join(sourceDir, "vault.db-wal"))
    ).rejects.toThrow(/ENOENT/u);
    await fs.writeFile(
      path.join(sourceDir, "seal.key"),
      pseudoRandomBuffer(32, 5)
    );

    const entries: SourceEntry[] = [
      {
        path: "vault.db",
        kind: "db",
        absolutePath: path.join(sourceDir, "vault.db"),
        sha256: await fileSha256(path.join(sourceDir, "vault.db")),
        walGeneration: GEN_VAULT,
        baseTickMs: BASE_TICK,
      },
      {
        path: "seal.key",
        kind: "seal-key",
        absolutePath: path.join(sourceDir, "seal.key"),
      },
    ];
    const genByPath = new Map([["vault.db", GEN_VAULT]]);
    return { provider, targetId, keyring, sourceDir, entries, genByPath };
  }

  test("roundtrip: registers /1, verifies the base sha256, and runs WAL replay", async () => {
    const { provider, targetId, keyring, sourceDir, entries } =
      await buildSqliteFixture();
    const row = await createSnapshot({
      provider,
      targetId,
      keyring,
      vaultId: "vault-1",
      entries,
      generation: 1,
      appMeta: APP_META,
    });
    expect(row).not.toBeNull();
    expect(row!.format).toBe("centraid-snapshot/2");
    expect(row!.format).toBe(SNAPSHOT_FORMAT_V2);

    const destDir = await tempDir("backup-engine-v2-restore-");
    await fs.rm(destDir, { recursive: true, force: true });
    const result = await restoreSnapshot({
      provider,
      targetId,
      keyring,
      vaultId: "vault-1",
      destDir,
      current: CURRENT,
    });

    // Empty stream (no segments shipped); the generation still flows through integrity.
    expect(result.walReplay).not.toBeNull();
    expect(result.walReplay!.generation).toBe(GEN_VAULT);
    expect(result.walReplay!.integrityCheck).toBe("ok");
    expect(result.walReplay!.segmentsApplied).toBe(0);
    expect(result.walReplay!.damaged).toStrictEqual([]);

    expect(readSqliteRows(path.join(destDir, "vault.db"))).toStrictEqual([
      "v1",
      "v2",
      "v3",
    ]);
    const originalSeal = await fs.readFile(path.join(sourceDir, "seal.key"));
    expect(
      (await fs.readFile(path.join(destDir, "seal.key"))).equals(originalSeal)
    ).toBe(true);
  });

  test("the db entry carries its baseTickMs", async () => {
    const { provider, targetId, keyring, entries } = await buildSqliteFixture();
    await createSnapshot({
      provider,
      targetId,
      keyring,
      vaultId: "vault-1",
      entries,
      generation: 1,
      appMeta: APP_META,
    });
    const row = (await provider.listSnapshots(targetId))[0]!;
    const store = await provider.openDataPlane(targetId, "backup", "read");
    const opened = openManifest(
      await store.get(row.manifestKey),
      keyring,
      "vault-1",
      row.manifestHash
    );
    const dbEntries = opened.entries.filter((e) => e.kind === "db");
    expect(dbEntries).toHaveLength(1);
    expect(dbEntries[0]!.baseTickMs).toBe(BASE_TICK);
  });

  test("a snapshot carrying a SECOND db entry is refused", async () => {
    // The snapshot names one database. A second `db` entry comes from another
    // protocol, and restoring it beside the vault would replay a stream the
    // manifest cannot vouch for.
    const { provider, targetId, keyring, entries, sourceDir } =
      await buildSqliteFixture();
    const extra: SourceEntry[] = [
      ...entries,
      {
        ...entries.find((e) => e.kind === "db")!,
        path: "other.db",
        absolutePath: path.join(sourceDir, "vault.db"),
      },
    ];
    await expect(
      createSnapshot({
        provider,
        targetId,
        keyring,
        vaultId: "vault-1",
        entries: extra,
        generation: 1,
        appMeta: APP_META,
      })
    ).rejects.toThrow(/exactly one vault\.db entry/u);
  });

  test("a /1 snapshot with NO base tick is refused (it cannot place its segments)", async () => {
    const { provider, targetId, keyring, entries } = await buildSqliteFixture();
    const stripped = entries.map(({ baseTickMs: _drop, ...rest }) => rest);
    await expect(
      createSnapshot({
        provider,
        targetId,
        keyring,
        vaultId: "vault-1",
        entries: stripped,
        generation: 1,
        appMeta: APP_META,
      })
    ).rejects.toThrow(/missing a valid base tick/u);
  });

  test("a WRONG sha256 in the db entry fails the restore before any replay", async () => {
    const { provider, targetId, keyring, entries } = await buildSqliteFixture();
    const tampered = entries.map((e) =>
      e.path === "vault.db" ? { ...e, sha256: "ab".repeat(32) } : e
    );
    await createSnapshot({
      provider,
      targetId,
      keyring,
      vaultId: "vault-1",
      entries: tampered,
      generation: 1,
      appMeta: APP_META,
    });
    const destDir = await tempDir("backup-engine-v2-badsha-");
    await fs.rm(destDir, { recursive: true, force: true });
    await expect(
      restoreSnapshot({
        provider,
        targetId,
        keyring,
        vaultId: "vault-1",
        destDir,
        current: CURRENT,
      })
    ).rejects.toThrow(/"vault\.db" hash mismatch/u);
    // Restore aborted: no quarantine marker.
    await expect(
      fs.access(path.join(destDir, "RESTORE_QUARANTINE.json"))
    ).rejects.toThrow(/ENOENT/u);
  });

  // No-change is over ENTRY METADATA, not just chunk bytes.

  test("a generation-only change (identical bytes, size and mtime) still REGISTERS a snapshot", async () => {
    // Fast path keys on `(size, mtimeMs)`. An idle clone can share both, so
    // a chunk-index-only no-change test would register nothing, never name
    // the live generation, and prune would delete its segments. The ENTRY
    // changed; that is what restore reads.
    const { provider, targetId, keyring, entries } = await buildSqliteFixture();
    const row1 = await createSnapshot({
      provider,
      targetId,
      keyring,
      vaultId: "vault-1",
      entries,
      generation: 1,
      appMeta: APP_META,
    });
    expect(row1).not.toBeNull();

    // Freeze `(size, mtimeMs)` to the previous manifest. ONLY `walGeneration` differs.
    const pinned = new Date(BASE_TICK);
    await Promise.all(
      entries.map((entry) => fs.utimes(entry.absolutePath, pinned, pinned))
    );
    const rolled = entries.map((e) =>
      e.kind === "db"
        ? { ...e, walGeneration: `${e.walGeneration!.slice(0, 30)}ff` }
        : e
    );

    const row2 = await createSnapshot({
      provider,
      targetId,
      keyring,
      vaultId: "vault-1",
      entries: rolled,
      generation: 1,
      appMeta: APP_META,
    });
    expect(row2).not.toBeNull();
    const rows = await provider.listSnapshots(targetId);
    expect(rows).toHaveLength(2);
    const store = await provider.openDataPlane(targetId, "backup", "read");
    const opened = openManifest(
      await store.get(rows[0]!.manifestKey),
      keyring,
      "vault-1",
      rows[0]!.manifestHash
    );

    expect(
      opened.entries.find((e) => e.path === "vault.db")!.walGeneration
    ).toBe(rolled.find((e) => e.path === "vault.db")!.walGeneration);

    expect(
      provider.lastStore!.putKeys.filter((k) => k.startsWith("chunks/"))
    ).toStrictEqual([]);
  });

  test("a same-stat base with DIFFERENT bytes is re-chunked, not reused (coarse mtime is not identity)", async () => {
    // Coarse mtime + same page count: `(size, mtimeMs)` alone would hand the
    // new generation the previous chunk refs. Identity is `sha256`, not stat.
    const { provider, targetId, keyring, sourceDir, entries } =
      await buildSqliteFixture();

    // Pin mtime BEFORE the first snapshot: the fast path compares against
    // that. Pinning only the second base never reaches the fast path.
    const pinned = new Date(BASE_TICK);
    await Promise.all(
      entries.map((entry) => fs.utimes(entry.absolutePath, pinned, pinned))
    );

    await createSnapshot({
      provider,
      targetId,
      keyring,
      vaultId: "vault-1",
      entries,
      generation: 1,
      appMeta: APP_META,
    });

    // Next generation: different rows, same file length (fixed pages).
    const vaultDb = path.join(sourceDir, "vault.db");
    const sizeBefore = (await fs.stat(vaultDb)).size;
    const staleSha = await fileSha256(vaultDb);
    await fs.rm(vaultDb, { force: true });
    makeSqliteDbFile(vaultDb, ["w1", "w2", "w3"]);
    expect((await fs.stat(vaultDb)).size).toBe(sizeBefore); // same size, new bytes
    await expect(fileSha256(vaultDb)).resolves.not.toBe(staleSha);
    // Re-pin after rewrite so both bases share (size, mtime).
    await Promise.all(
      entries.map((entry) => fs.utimes(entry.absolutePath, pinned, pinned))
    );

    const next = await Promise.all(
      entries.map(async (e) =>
        e.path === "vault.db"
          ? {
              ...e,
              sha256: await fileSha256(vaultDb),
              walGeneration: `${GEN_VAULT.slice(0, 30)}ff`,
            }
          : e
      )
    );
    expect(next.find((e) => e.path === "vault.db")!.sha256).not.toBe(
      entries.find((e) => e.path === "vault.db")!.sha256
    );

    const row = await createSnapshot({
      provider,
      targetId,
      keyring,
      vaultId: "vault-1",
      entries: next,
      generation: 1,
      appMeta: APP_META,
    });
    expect(row).not.toBeNull();

    // Stale chunk refs throw `"vault.db" hash mismatch`.
    const destDir = await tempDir("backup-engine-v2-samestat-");
    await fs.rm(destDir, { recursive: true, force: true });
    await restoreSnapshot({
      provider,
      targetId,
      keyring,
      vaultId: "vault-1",
      destDir,
      current: CURRENT,
    });
    await expect(fileSha256(path.join(destDir, "vault.db"))).resolves.toBe(
      await fileSha256(vaultDb) // the NEW base, not its same-stat predecessor
    );
  });
});

describe("snapshot format gate", () => {
  test("v0 reads and writes only the current compressed snapshot format", () => {
    expect(READABLE_SNAPSHOT_FORMATS).toStrictEqual(["centraid-snapshot/2"]);
    expect(SNAPSHOT_FORMAT_V2).toBe("centraid-snapshot/2");
  });

  test("restore refuses a row whose format is outside the reader guarantee", async () => {
    const { provider, targetId, keyring, entries } = await buildFixture();
    await createSnapshot({
      provider,
      targetId,
      keyring,
      vaultId: "vault-1",
      entries,
      generation: 1,
      appMeta: APP_META,
    });
    await provider.registerSnapshot(targetId, {
      idempotencyKey: "format-9",
      manifestKey: `u/${targetId}/backup/manifests/9.json`,
      manifestHash: "f".repeat(64),
      totalBytes: 1,
      objectCount: 0,
      generation: 1,
      format: "centraid-snapshot/9",
      appMeta: APP_META,
    });
    const destDir = await tempDir("backup-engine-fmt9-");
    await fs.rm(destDir, { recursive: true, force: true });
    await expect(
      restoreSnapshot({
        provider,
        targetId,
        keyring,
        vaultId: "vault-1",
        destDir,
        current: CURRENT,
      })
    ).rejects.toThrow(/unknown format "centraid-snapshot\/9"/u);
  });
});

describe("point-in-time snapshot row selection", () => {
  interface PitrFixture {
    provider: LocalBackupProvider;
    targetId: string;
    keyring: Awaited<ReturnType<typeof createKeyring>>;
    contentV1: Buffer;
    contentV2: Buffer;
  }

  /**
   * Seq 1 at 1000s, seq 2 at 2000s. LocalBackupProvider stamps createdAt from
   * the wall clock (epoch seconds), so rewrite registry.json after register —
   * it re-reads from disk; this is the real cross-process contract.
   */
  async function pitrFixture(): Promise<PitrFixture> {
    const rootDir = await tempDir("backup-engine-pitr-");
    const provider = new LocalBackupProvider({ rootDir });
    const { targetId } = await provider.createTarget({ label: "pitr-test" });
    const keyringDir = await tempDir("backup-engine-keyring-");
    const keyring = await createKeyring(path.join(keyringDir, "keyring.json"));
    const sourceDir = await tempDir("backup-engine-source-");
    const filePath = path.join(sourceDir, "seal.key");
    const vaultPath = path.join(sourceDir, "vault.db");
    makeSqliteDbFile(vaultPath, ["base"]);
    const baseEntries: SourceEntry[] = [
      {
        path: "vault.db",
        kind: "db",
        absolutePath: vaultPath,
        sha256: await fileSha256(vaultPath),
        walGeneration: "33".repeat(16),
        baseTickMs: 1_000_000,
      },
      { path: "seal.key", kind: "seal-key", absolutePath: filePath },
    ];
    const contentV1 = Buffer.from("generation-one-content");
    const contentV2 = Buffer.from("generation-TWO-content");

    await fs.writeFile(filePath, contentV1);
    const row1 = await createSnapshot({
      provider,
      targetId,
      keyring,
      vaultId: "vault-1",
      entries: baseEntries,
      generation: 1,
      appMeta: APP_META,
    });
    await fs.writeFile(filePath, contentV2);
    const future = new Date(Date.now() + 5000);
    await fs.utimes(filePath, future, future);
    const secondEntries = baseEntries.map((entry) =>
      entry.kind === "db" ? { ...entry, baseTickMs: 2_000_000 } : entry
    );
    const row2 = await createSnapshot({
      provider,
      targetId,
      keyring,
      vaultId: "vault-1",
      entries: secondEntries,
      generation: 1,
      appMeta: APP_META,
    });
    expect(row1?.seq).toBe(1);
    expect(row2?.seq).toBe(2);

    const registryFile = path.join(rootDir, "registry.json");
    const registry = JSON.parse(await fs.readFile(registryFile, "utf8")) as {
      snapshots: Record<string, { seq: number; createdAt: number }[]>;
    };
    for (const r of registry.snapshots[targetId]!) {
      r.createdAt = r.seq === 1 ? 1000 : 2000; // epoch seconds, newest-first list
    }
    await fs.writeFile(registryFile, JSON.stringify(registry, null, 2));
    return { provider, targetId, keyring, contentV1, contentV2 };
  }

  async function restoreWith(
    f: PitrFixture,
    opts: { seq?: number; pointInTimeMs?: number }
  ): Promise<Buffer> {
    const destDir = await tempDir("backup-engine-pitr-dest-");
    await fs.rm(destDir, { recursive: true, force: true });
    await restoreSnapshot({
      provider: f.provider,
      targetId: f.targetId,
      keyring: f.keyring,
      vaultId: "vault-1",
      ...opts,
      destDir,
      current: CURRENT,
    });
    return fs.readFile(path.join(destDir, "seal.key"));
  }

  test("pointInTimeMs picks the newest snapshot created at or before T", async () => {
    const f = await pitrFixture();
    const restoreAt = (pointInTimeMs: number): Promise<Buffer> =>
      restoreWith(f, { pointInTimeMs });

    expect((await restoreAt(1_500_000)).equals(f.contentV1)).toBe(true);
    // createdAt is inclusive (<=, not <).
    expect((await restoreAt(1_000_000)).equals(f.contentV1)).toBe(true);

    expect((await restoreAt(2_500_000)).equals(f.contentV2)).toBe(true);
    // Before every snapshot → refuse, never restore something newer.
    await expect(restoreAt(500_000)).rejects.toThrow(
      /no snapshot exists at or before/u
    );
  });

  test("seq + pointInTimeMs: a base NEWER than the requested instant is refused, not served", async () => {
    const f = await pitrFixture();

    // seq 2's base is after T. A base cannot be rewound — refuse.
    await expect(
      restoreWith(f, { seq: 2, pointInTimeMs: 1_500_000 })
    ).rejects.toThrow(
      /seq 2 has a base at .* NEWER than the requested point in time/u
    );

    // Named base at or before T, replayed up to T, is legal.
    expect(
      (await restoreWith(f, { seq: 1, pointInTimeMs: 1_500_000 })).equals(
        f.contentV1
      )
    ).toBe(true);
    // createdAt is inclusive.
    expect(
      (await restoreWith(f, { seq: 2, pointInTimeMs: 2_000_000 })).equals(
        f.contentV2
      )
    ).toBe(true);

    expect((await restoreWith(f, { seq: 2 })).equals(f.contentV2)).toBe(true);
  });
});

describe("deterministic objects (G7 — idempotent uploads)", () => {
  test("the same content under the same keyring/vault produces byte-identical chunk objects", async () => {
    const keyringDir = await tempDir("backup-engine-keyring-");
    const keyring = await createKeyring(path.join(keyringDir, "keyring.json"));
    const sourceDir = await tempDir("backup-engine-source-");
    const entries = await buildSourceTree(sourceDir);

    async function snapshotIntoFreshProvider(): Promise<Map<string, Buffer>> {
      const rootDir = await tempDir("backup-engine-det-");
      const provider = new LocalBackupProvider({ rootDir });
      const { targetId } = await provider.createTarget({ label: "det-test" });
      const row = await createSnapshot({
        provider,
        targetId,
        keyring,
        vaultId: "vault-1",
        entries,
        generation: 1,
        appMeta: APP_META,
      });
      expect(row).not.toBeNull();
      const store = await provider.openDataPlane(targetId, "backup", "read");
      const chunks = new Map<string, Buffer>();
      for await (const obj of store.list("chunks/")) {
        chunks.set(obj.key, Buffer.from(await store.get(obj.key)));
      }
      return chunks;
    }

    const first = await snapshotIntoFreshProvider();
    const second = await snapshotIntoFreshProvider();
    expect(first.size).toBeGreaterThan(0);
    expect([...second.keys()].sort()).toStrictEqual([...first.keys()].sort());
    for (const [key, bytes] of first) {
      // Encrypted bytes identical: nonce derives from the keyed content hash.
      expect(second.get(key)!.equals(bytes)).toBe(true);
    }
  });
});

// Entropy-gated compression (/2, #405 §1) on the real seal path, not just compress.test.ts.

/** Compressible SQLite (DELETE journal) — repeated text, page slack. */
function makeCompressibleDb(file: string, rows: number): void {
  const db = new DatabaseSync(file);
  db.exec(
    "PRAGMA journal_mode=DELETE; CREATE TABLE t (id INTEGER PRIMARY KEY, note TEXT)"
  );
  const insert = db.prepare("INSERT INTO t (note) VALUES (?)");
  const line = "the quick brown fox jumps over the lazy dog — ".repeat(6);
  db.exec("BEGIN");
  for (let i = 0; i < rows; i++) insert.run(`${line}${i % 97}`);
  db.exec("COMMIT");
  db.close();
}

async function sumStoredChunkBytes(store: ObjectStore): Promise<number> {
  let total = 0;
  for await (const obj of store.list("chunks/")) total += obj.size;
  return total;
}

describe("entropy-gated compression (/2, #405 §1)", () => {
  test("a repetitive SQLite base compresses to well under a third of its raw size", async () => {
    const rootDir = await tempDir("backup-compress-root-");
    const provider = new LocalBackupProvider({ rootDir });
    const { targetId } = await provider.createTarget({ label: "compress" });
    const keyringDir = await tempDir("backup-compress-keyring-");
    const keyring = await createKeyring(path.join(keyringDir, "keyring.json"));
    const sourceDir = await tempDir("backup-compress-source-");

    const vaultPath = path.join(sourceDir, "vault.db");
    makeCompressibleDb(vaultPath, 40_000); // multi-MB, highly compressible
    const rawBytes = (await fs.stat(vaultPath)).size;

    const entries: SourceEntry[] = [
      {
        path: "vault.db",
        kind: "db",
        absolutePath: vaultPath,
        sha256: await fileSha256(vaultPath),
        walGeneration: "33".repeat(16),
        baseTickMs: 1_752_480_000_000,
      },
    ];

    await createSnapshot({
      provider,
      targetId,
      keyring,
      vaultId: "vault-1",
      entries,
      generation: 1,
      appMeta: APP_META,
    });

    const store = await provider.openDataPlane(targetId, "backup", "read");
    const storedBytes = await sumStoredChunkBytes(store);
    // SQLite fixture ≥3×; encryption is ~28 bytes/object, so zstd dominates.
    expect(rawBytes / storedBytes).toBeGreaterThanOrEqual(3);
  });

  test("mixed compressed + stored chunks in one snapshot round-trip byte-identically", async () => {
    const rootDir = await tempDir("backup-mixed-root-");
    const provider = new LocalBackupProvider({ rootDir });
    const { targetId } = await provider.createTarget({ label: "mixed" });
    const keyringDir = await tempDir("backup-mixed-keyring-");
    const keyring = await createKeyring(path.join(keyringDir, "keyring.json"));
    const sourceDir = await tempDir("backup-mixed-source-");

    const vaultPath = path.join(sourceDir, "vault.db");
    makeCompressibleDb(vaultPath, 8_000); // compressible → stored as zstd
    // Incompressible blob → stored raw. One snapshot, both algos.
    const blobPath = path.join(sourceDir, "random.bin");
    await fs.writeFile(blobPath, pseudoRandomBuffer(300_000, 99));

    const entries: SourceEntry[] = [
      {
        path: "vault.db",
        kind: "db",
        absolutePath: vaultPath,
        sha256: await fileSha256(vaultPath),
        walGeneration: "55".repeat(16),
        baseTickMs: 1_752_480_000_000,
      },
      { path: "random.bin", kind: "blob", absolutePath: blobPath },
    ];

    await createSnapshot({
      provider,
      targetId,
      keyring,
      vaultId: "vault-1",
      entries,
      generation: 1,
      appMeta: APP_META,
    });

    // Unseal: both zstd (0x01) and stored (0x00) frames.
    const { key: master } = activeMasterKey(keyring);
    const dataKey = deriveDataKey(master, "vault-1");
    const store = await provider.openDataPlane(targetId, "backup", "read");
    const algos = new Set<number>();
    for await (const obj of store.list("chunks/")) {
      const sealed = decrypt(dataKey, await store.get(obj.key));
      algos.add(sealed[0]!); // the frame's algo id byte
      expect(unframeChunkPayload(sealed).length).toBeGreaterThan(0); // and it still unframes
    }
    expect(algos.has(ALGO_ZSTD)).toBe(true);
    expect(algos.has(ALGO_STORE)).toBe(true);

    const destDir = await tempDir("backup-mixed-restore-");
    await fs.rm(destDir, { recursive: true, force: true });
    await restoreSnapshot({
      provider,
      targetId,
      keyring,
      vaultId: "vault-1",
      destDir,
      current: CURRENT,
    });
    const restoredPairs = await Promise.all(
      entries.map(async (entry) => {
        const [original, restored] = await Promise.all([
          fs.readFile(entry.absolutePath),
          fs.readFile(path.join(destDir, ...entry.path.split("/"))),
        ]);
        return { original, restored };
      })
    );
    restoredPairs.forEach(({ original, restored }) =>
      expect(restored.equals(original)).toBe(true)
    );

    const verified = await verifySnapshot({
      provider,
      targetId,
      keyring,
      vaultId: "vault-1",
    });
    expect(verified.missing).toStrictEqual([]);
    expect(verified.corrupt).toStrictEqual([]);
  });

  test("chunk ids key off RAW plaintext — identical whether or not compression kicked in", async () => {
    const rootDir = await tempDir("backup-id-root-");
    const provider = new LocalBackupProvider({ rootDir });
    const { targetId } = await provider.createTarget({ label: "ids" });
    const keyringDir = await tempDir("backup-id-keyring-");
    const keyring = await createKeyring(path.join(keyringDir, "keyring.json"));
    const sourceDir = await tempDir("backup-id-source-");

    // Recompute id HMAC-over-raw and demand it matches the compressed snapshot.
    const raw = new Uint8Array(2 * 1024 * 1024);
    raw.fill(0x41);
    const vaultPath = path.join(sourceDir, "vault.db");
    makeCompressibleDb(vaultPath, 100);
    const blobPath = path.join(sourceDir, "flat.bin");
    await fs.writeFile(blobPath, raw);

    const entries: SourceEntry[] = [
      {
        path: "vault.db",
        kind: "db",
        absolutePath: vaultPath,
        sha256: await fileSha256(vaultPath),
        walGeneration: "77".repeat(16),
        baseTickMs: 1_752_480_000_000,
      },
      { path: "flat.bin", kind: "blob", absolutePath: blobPath },
    ];

    const row = await createSnapshot({
      provider,
      targetId,
      keyring,
      vaultId: "vault-1",
      entries,
      generation: 1,
      appMeta: APP_META,
    });

    const { key: master } = activeMasterKey(keyring);
    const dedupKey = deriveDedupKey(master, "vault-1");
    const dataKey = deriveDataKey(master, "vault-1");
    const expectedIds = (await partBuffer(raw)).map((part) =>
      chunkId(dedupKey, part)
    );

    const store = await provider.openDataPlane(targetId, "backup", "read");
    const opened = openManifest(
      await store.get(row!.manifestKey),
      keyring,
      "vault-1",
      row!.manifestHash
    );
    const blobEntry = opened.entries.find((e) => e.path === "flat.bin")!;
    // Compression changed stored bytes, never the id.
    expect(blobEntry.chunks).toStrictEqual(expectedIds);

    // Confirm zstd frame byte so this is not "compression didn't run".
    const sealedChunks = await Promise.all(
      blobEntry.chunks.map(async (id) => ({
        id,
        sealed: decrypt(dataKey, await store.get(`chunks/${id}`)),
      }))
    );
    sealedChunks.forEach(({ id, sealed }) => {
      expect(sealed[0]).toBe(ALGO_ZSTD);
      const plain = unframeChunkPayload(sealed);
      expect(chunkId(dedupKey, plain)).toBe(id);
    });
  });
});
