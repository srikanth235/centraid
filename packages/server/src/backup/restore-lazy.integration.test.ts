import crypto, { randomBytes } from "node:crypto";
/*
 * Previews-first lazy restore (#405), scaled to tiny buffers: a seeded vault
 * goes through the REAL BackupService/LocalBackupProvider, a blob subset
 * replicates to an in-memory remote CAS, and a LAZY restore asserts the §5
 * contract — DB intact; remote-held blobs stay remote-only with read-through;
 * local-only blobs materialize; ALL tinies warm into the spool; deferred
 * originals read-through on demand; time-to-usable-grid reported.
 *
 * Snapshots carry EVERY local CAS blob (backup-sources.ts §b); the per-blob
 * lazy SKIP keyed on live `has(sha)` trims the restore.
 */
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, test, vi } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";
import { BlobCustody, FsBlobStore, ReplicaIndex } from "@centraid/vault";
import type {
  BlobRange,
  BlobStat,
  BlobStore,
  RemoteTier,
} from "@centraid/vault";

import { HealthRegistry } from "../serve/health-registry.js";
import type { VaultPlane } from "../serve/vault-plane.js";
import { openVaultRegistry } from "../serve/vault-registry.js";
import type { BackupConfig } from "./backup-config.js";
import { BackupService } from "./backup-service.js";

vi.setConfig({ testTimeout: 30_000 });

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** Minimal async remote CAS keyed by plaintext sha, like S3BlobStore; no
 *  `putStream`, so small blobs ride the buffered `put` path. */
class MemoryRemoteStore implements BlobStore {
  readonly kind = "memory-remote";
  private readonly objects = new Map<string, Buffer>();

  put(sha: string, bytes: Buffer): Promise<void> {
    this.objects.set(sha, Buffer.from(bytes));
    return Promise.resolve();
  }
  get(sha: string, range?: BlobRange): Promise<Buffer | null> {
    const whole = this.objects.get(sha);
    if (!whole) return Promise.resolve(null);
    if (!range) return Promise.resolve(whole);
    const end = Math.min(range.end ?? whole.length - 1, whole.length - 1);
    return Promise.resolve(whole.subarray(range.start, end + 1));
  }
  has(sha: string): Promise<boolean> {
    return Promise.resolve(this.objects.has(sha));
  }
  delete(sha: string): Promise<void> {
    this.objects.delete(sha);
    return Promise.resolve();
  }
  list(): Promise<string[]> {
    return Promise.resolve([...this.objects.keys()]);
  }
  stat(sha: string): Promise<BlobStat | null> {
    const whole = this.objects.get(sha);
    return Promise.resolve(whole ? { size: whole.length } : null);
  }
}

function invoke(
  plane: VaultPlane,
  command: string,
  input: Record<string, unknown>
): Record<string, unknown> {
  const out = plane.gateway.invoke(plane.ownerCredential, { command, input });
  if (out.status !== "executed")
    throw new Error(`${command} failed: ${JSON.stringify(out)}`);
  return (out as { output: Record<string, unknown> }).output;
}

/** Stage bytes into the vault's local CAS — same ingress `core.attach` uses. */
function stage(plane: VaultPlane, bytes: Buffer, name: string): string {
  return plane.gateway.stageBlob(plane.ownerCredential, {
    bytes,
    mediaType: "application/octet-stream",
    filename: name,
  }).sha256;
}

function declareRemotePrimary(plane: VaultPlane): void {
  const row = plane.db.vault
    .prepare("SELECT settings_json FROM core_vault LIMIT 1")
    .get() as {
    settings_json: string | null;
  };
  const settings = row.settings_json
    ? (JSON.parse(row.settings_json) as Record<string, unknown>)
    : {};
  plane.db.vault.prepare("UPDATE core_vault SET settings_json = ?").run(
    JSON.stringify({
      ...settings,
      blob_store: {
        kind: "s3",
        endpoint: "https://remote-primary.invalid",
        bucket: "restore-e2e",
      },
    })
  );
}

describe("restore-lazy", () => {
  test("lazy restore: a library bigger than local disk restores previews-first — remote-held blobs stay remote-only, local-only blobs materialize, tinies warm", async () => {
    const vaultDir = await tempDir("lazy-vault");
    const providerDir = await tempDir("lazy-provider");
    const backupDir = await tempDir("lazy-backup");
    const config: BackupConfig = {
      enabled: true,
      provider: { kind: "local", dir: providerDir },
    };
    const registry = openVaultRegistry({
      rootDir: vaultDir,
      logger: silentLogger,
      ownerName: "Mara",
    });
    registry.create("Personal");
    const vaultId = registry.defaultVaultId();
    const plane = registry.get(vaultId)!;
    const health = new HealthRegistry();
    const service = new BackupService({
      config,
      cacheDir: backupDir,
      vaults: registry,
      health,
      logger: silentLogger,
    });

    // The remote CAS + seal key; injected here, configured in production.
    const remoteStore = new MemoryRemoteStore();
    const sealKey = randomBytes(32);
    const remote: RemoteTier = { store: remoteStore, encryptKey: sealKey };

    try {
      // 1. Seed three "image" items, each an ORIGINAL blob plus a tiny THUMB
      // derivative row — what the warm pass reads.
      const originals: { contentId: string; sha: string; bytes: Buffer }[] = [];
      const thumbs: { sha: string; bytes: Buffer }[] = [];
      for (let i = 0; i < 3; i++) {
        const taskId = invoke(plane, "schedule.add_task", {
          title: `Photo ${i}`,
        })["task_id"] as string;
        const originalBytes = randomBytes(400 + i); // distinct bytes ⇒ distinct shas
        const originalSha = stage(plane, originalBytes, `photo-${i}.bin`);
        const attach = invoke(plane, "core.attach", {
          subject_type: "schedule.task",
          subject_id: taskId,
          staged_sha: originalSha,
        });
        const contentId = attach["content_id"] as string;
        expect(contentId).toBeTruthy();
        originals.push({ contentId, sha: originalSha, bytes: originalBytes });

        const thumbBytes = randomBytes(64 + i);
        const thumbSha = stage(plane, thumbBytes, `photo-${i}.thumb`);
        plane.db.vault
          .prepare(
            `INSERT INTO core_content_derivative
             (derivative_id, content_id, variant, sha256, media_type, byte_size, created_at)
           VALUES (?, ?, 'thumb', ?, 'image/webp', ?, ?)`
          )
          .run(
            crypto.randomUUID(),
            contentId,
            thumbSha,
            thumbBytes.length,
            new Date().toISOString()
          );
        thumbs.push({ sha: thumbSha, bytes: thumbBytes });
      }

      // 2. Replicate originals[0..1] plus ALL thumbs; originals[2] stays
      // local-only so lazy still has to materialize it.
      const seedCustody = new BlobCustody(
        new FsBlobStore(path.join(plane.dir, "blobs")),
        () => remote
      );
      const replicated = [
        originals[0]!.sha,
        originals[1]!.sha,
        ...thumbs.map((t) => t.sha),
      ];
      await seedCustody.replicate(replicated);
      await Promise.all(
        replicated.map((sha) =>
          expect(remoteStore.has(sha)).resolves.toBe(true)
        )
      );
      await expect(remoteStore.has(originals[2]!.sha)).resolves.toBe(false);

      // 3. Snapshot the whole vault.
      await service.runBackup(vaultId);
      expect((await service.status())[vaultId]?.lastSeq).toBe(1);

      // 4. LAZY restore into a fresh dest.
      const destParent = await tempDir("lazy-dest");
      const destDir = path.join(destParent, "restored");
      const result = await service.restore({
        vaultId,
        destDir,
        lazy: { remote },
      });

      // --- The DB restored intact ---
      expect(result.entries).toContain("vault.db");
      const restoredDb = new DatabaseSync(path.join(destDir, "vault.db"), {
        readOnly: true,
      });
      try {
        const taskCount = (
          restoredDb
            .prepare("SELECT COUNT(*) AS n FROM schedule_task")
            .get() as { n: number }
        ).n;
        expect(taskCount).toBe(3);
        const thumbCount = (
          restoredDb
            .prepare(
              `SELECT COUNT(*) AS n FROM core_content_derivative WHERE variant = 'thumb'`
            )
            .get() as { n: number }
        ).n;
        expect(thumbCount).toBe(3);
      } finally {
        restoredDb.close();
      }

      // --- Remote-held blobs DEFERRED, local-only blob MATERIALIZED ---
      const destBlobs = new FsBlobStore(path.join(destDir, "blobs"));
      expect(destBlobs.hasSync(originals[0]!.sha)).toBe(false); // remote holds it ⇒ skipped
      expect(destBlobs.hasSync(originals[1]!.sha)).toBe(false); // remote holds it ⇒ skipped
      expect(destBlobs.hasSync(originals[2]!.sha)).toBe(true); // local-only ⇒ materialized
      expect(result.skippedBlobs).toContain(originals[0]!.sha);
      expect(result.skippedBlobs).toContain(originals[1]!.sha);
      expect(result.skippedBlobs).not.toContain(originals[2]!.sha);

      // --- The warm pass made ALL tinies present locally (usable grid) ---
      for (const t of thumbs) expect(destBlobs.hasSync(t.sha)).toBe(true);

      // --- The §5 time-to-usable-grid metric is reported ---
      expect(result.previewsWarm).toBeDefined();
      expect(result.previewsWarm!.tiniesTotal).toBe(3);
      expect(result.previewsWarm!.tiniesWarmed).toBe(3);
      expect(result.previewsWarm!.tiniesFailed).toBe(0);
      expect(result.previewsWarm!.timeToUsableGridMs).toBeTypeOf("number");
      expect(result.previewsWarm!.timeToUsableGridMs).toBeGreaterThanOrEqual(0);

      // --- Deferred originals read-through on demand ---
      const readCustody = new BlobCustody(
        new FsBlobStore(path.join(destDir, "blobs")),
        () => remote
      );
      const readBack = await readCustody.open(originals[0]!.sha);
      expect(readBack).not.toBeNull();
      expect(readBack!.equals(originals[0]!.bytes)).toBe(true);
      const localOnly = await readCustody.open(originals[2]!.sha);
      expect(localOnly!.equals(originals[2]!.bytes)).toBe(true);
    } finally {
      registry.stop();
    }
  }, 30_000);

  test("remote-primary snapshot restores from provider bytes plus only the durable outbox", async () => {
    const vaultDir = await tempDir("remote-primary-vault");
    const providerDir = await tempDir("remote-primary-provider");
    const backupDir = await tempDir("remote-primary-backup");
    const registry = openVaultRegistry({
      rootDir: vaultDir,
      logger: silentLogger,
      ownerName: "Mara",
    });
    registry.create("Personal");
    const vaultId = registry.defaultVaultId();
    const plane = registry.get(vaultId)!;
    const service = new BackupService({
      config: { enabled: true, provider: { kind: "local", dir: providerDir } },
      cacheDir: backupDir,
      vaults: registry,
      health: new HealthRegistry(),
      logger: silentLogger,
    });
    const remoteStore = new MemoryRemoteStore();
    const remote: RemoteTier = {
      store: remoteStore,
      encryptKey: randomBytes(32),
    };

    try {
      declareRemotePrimary(plane);
      const taskId = invoke(plane, "schedule.add_task", {
        title: "Restore split custody",
      })["task_id"] as string;
      const remoteBytes = randomBytes(700);
      const pendingBytes = randomBytes(701);
      const remoteSha = stage(plane, remoteBytes, "remote.bin");
      const pendingSha = stage(plane, pendingBytes, "pending.bin");
      for (const sha of [remoteSha, pendingSha]) {
        invoke(plane, "core.attach", {
          subject_type: "schedule.task",
          subject_id: taskId,
          staged_sha: sha,
        });
      }

      const seedCustody = new BlobCustody(
        new FsBlobStore(path.join(plane.dir, "blobs")),
        () => remote
      );
      await seedCustody.replicate([remoteSha]);
      new ReplicaIndex(plane.db.vault).mark(remoteSha, remoteBytes.length);
      plane.db.blobTransfers.state.completeOutbox(remoteSha);
      expect(plane.db.blobTransfers.pendingSnapshotShas()).toStrictEqual([
        pendingSha,
      ]);

      await service.runBackup(vaultId);
      const destDir = path.join(
        await tempDir("remote-primary-dest"),
        "restored"
      );
      const result = await service.restore({
        vaultId,
        destDir,
        lazy: { remote },
      });
      const restoredLocal = new FsBlobStore(path.join(destDir, "blobs"));

      // Remote-primary originals never enter the snapshot; the restored DB
      // still addresses them by SHA for later read-through.
      expect(result.entries.some((entry) => entry.endsWith(remoteSha))).toBe(
        false
      );
      expect(result.skippedBlobs).not.toContain(pendingSha);
      expect(restoredLocal.hasSync(remoteSha)).toBe(false);
      expect(restoredLocal.hasSync(pendingSha)).toBe(true);
      expect((await restoredLocal.get(pendingSha))?.equals(pendingBytes)).toBe(
        true
      );

      const restoredCustody = new BlobCustody(restoredLocal, () => remote);
      expect((await restoredCustody.open(remoteSha))?.equals(remoteBytes)).toBe(
        true
      );
    } finally {
      registry.stop();
    }
  }, 30_000);
});
