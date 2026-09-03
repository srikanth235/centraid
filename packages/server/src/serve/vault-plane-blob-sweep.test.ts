import crypto from "node:crypto";

import { afterAll, describe, expect, test } from "vitest";

import { S3TestServer } from "@centraid/backup/dist/testing/s3-test-server.js";
import { forEachSequentially } from "@centraid/test-kit/sequential";
import { tempDir } from "@centraid/test-kit/temp-dir";
import { blobUriFor, updateBlobStoreSettings, uuidv7 } from "@centraid/vault";

import { blobSweepBackoff, openVaultPlane } from "./vault-plane.js";
import type { VaultPlane } from "./vault-plane.js";

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const cleanups: Array<() => Promise<void> | void> = [];
describe("vault-plane-blob-sweep", () => {
  afterAll(async () => {
    await forEachSequentially(cleanups.splice(0).toReversed(), (cleanup) =>
      cleanup()
    );
  });
  async function startServer(): Promise<S3TestServer> {
    const server = await S3TestServer.start();
    cleanups.push(() => server.close());
    return server;
  }

  async function until(
    check: () => boolean | Promise<boolean>,
    timeoutMs = 3000
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    async function poll(): Promise<void> {
      if (await check()) return;
      if (Date.now() > deadline)
        throw new Error("timed out waiting for condition");
      await new Promise((resolve) => {
        setTimeout(resolve, 15);
      });
      return poll();
    }
    return poll();
  }

  async function heldThroughout(
    check: () => boolean,
    holdMs: number
  ): Promise<boolean> {
    const deadline = Date.now() + holdMs;
    async function poll(): Promise<boolean> {
      if (Date.now() >= deadline) return check();
      if (!check()) return false;
      await new Promise((resolve) => {
        setTimeout(resolve, 15);
      });
      return poll();
    }
    return poll();
  }

  describe("blobSweepBackoff (pure)", () => {
    test("no failures yet — never skips", () => {
      expect(
        blobSweepBackoff(
          { consecutiveFailures: 0, lastAttemptedAt: null },
          Date.now()
        )
      ).toStrictEqual({
        skip: false,
        retryInMs: 0,
      });
    });

    test("one failure, just attempted — skips, retry window > 0", () => {
      const now = Date.now();
      const result = blobSweepBackoff(
        {
          consecutiveFailures: 1,
          lastAttemptedAt: new Date(now).toISOString(),
        },
        now
      );
      expect(result.skip).toBe(true);
      expect(result.retryInMs).toBeGreaterThan(0);
    });

    test("one failure, long enough ago — proceeds", () => {
      const now = Date.now();
      const longAgo = new Date(now - 10 * 60_000).toISOString(); // 10 minutes ago
      expect(
        blobSweepBackoff(
          { consecutiveFailures: 1, lastAttemptedAt: longAgo },
          now
        ).skip
      ).toBe(false);
    });

    test("many consecutive failures cap at the max backoff window, not unbounded growth", () => {
      const now = Date.now();
      const recentEnough = new Date(now - 31 * 60_000).toISOString(); // 31 minutes ago
      expect(
        blobSweepBackoff(
          { consecutiveFailures: 100, lastAttemptedAt: recentEnough },
          now
        ).skip
      ).toBe(false);
    });
  });

  describe("VaultPlane blob sweep — real S3, lease gate + resumability", () => {
    function openPlane(
      dir: string,
      opts: { endpoint: string; skipOrphanDelete: () => boolean }
    ): VaultPlane {
      const plane = openVaultPlane({
        bootstrap: true,
        dir,
        logger: silentLogger,
        ownerName: "Priya",
        sweepIntervalMs: 25, // fast tick for the test
        skipOrphanDelete: opts.skipOrphanDelete,
        s3Credentials: async () => ({
          accessKeyId: "AKIA_TEST",
          secretAccessKey: "secret_test",
        }),
      });
      updateBlobStoreSettings(plane.db, {
        blob_store: {
          kind: "s3",
          endpoint: opts.endpoint,
          region: "us-east-1",
          bucket: "b",
          prefix: "p",
        },
      });
      cleanups.push(() => plane.stop());
      return plane;
    }

    test("possible cross-host writer pauses orphan-delete; clearing the risk resumes it", async () => {
      const server = await startServer();
      const dir = await tempDir();
      let conflicted = true;
      const plane = openPlane(dir, {
        endpoint: server.url,
        skipOrphanDelete: () => conflicted,
      });

      const orphanSha = crypto
        .createHash("sha256")
        .update("writer-risk-orphan")
        .digest("hex");
      server.putObjectDirect(
        "b",
        `p/blobs/sha256/${orphanSha}`,
        Buffer.from("orphan")
      );

      plane.start();
      await expect(
        heldThroughout(
          () => server.hasObjectDirect("b", `p/blobs/sha256/${orphanSha}`),
          200
        )
      ).resolves.toBe(true);

      conflicted = false;
      await until(
        () => !server.hasObjectDirect("b", `p/blobs/sha256/${orphanSha}`),
        3000
      );
    });

    test("sweep is resumable after a restart — a fresh VaultPlane over the same dir picks the backlog straight back up", async () => {
      const server = await startServer();
      const dir = await tempDir();
      const plane1 = openPlane(dir, {
        endpoint: server.url,
        skipOrphanDelete: () => false,
      });

      const bytes = Buffer.from("resumable content");
      const { sha256: sha, byteSize } = plane1.db.blobs.ingestSync(bytes);
      plane1.db.vault
        .prepare(
          `INSERT INTO core_content_item (content_id, media_type, content_uri, sha256, byte_size, created_at)
         VALUES (?, 'application/octet-stream', ?, ?, ?, datetime('now'))`
        )
        .run(uuidv7(), blobUriFor(sha), sha, byteSize);
      plane1.stop();
      await expect(makeS3List(server)).resolves.not.toContain(sha);

      const plane2 = openPlane(dir, {
        endpoint: server.url,
        skipOrphanDelete: () => false,
      });
      plane2.start();
      await until(async () => (await makeS3List(server)).includes(sha), 3000);
      expect(plane2.db.blobs.hasSync(sha)).toBe(true);
    });

    test("a retained-snapshot GC root survives the sweep; a genuine orphan does not (issue #436 §6)", async () => {
      const server = await startServer();
      const dir = await tempDir();
      const plane = openPlane(dir, {
        endpoint: server.url,
        skipOrphanDelete: () => false,
      });

      const pinnedSha = crypto
        .createHash("sha256")
        .update("snapshot-referenced")
        .digest("hex");
      const straySha = crypto
        .createHash("sha256")
        .update("true-orphan")
        .digest("hex");
      server.putObjectDirect(
        "b",
        `p/blobs/sha256/${pinnedSha}`,
        Buffer.from("pin")
      );
      server.putObjectDirect(
        "b",
        `p/blobs/sha256/${straySha}`,
        Buffer.from("stray")
      );
      plane.snapshotBlobRoots = async () => new Set([pinnedSha]);

      plane.start();
      await until(
        () => !server.hasObjectDirect("b", `p/blobs/sha256/${straySha}`),
        3000
      );
      expect(server.hasObjectDirect("b", `p/blobs/sha256/${pinnedSha}`)).toBe(
        true
      );
    });

    test("when the snapshot-roots supplier throws, orphan-delete fails safe — nothing is deleted (issue #436 §6)", async () => {
      const server = await startServer();
      const dir = await tempDir();
      const plane = openPlane(dir, {
        endpoint: server.url,
        skipOrphanDelete: () => false,
      });

      const orphanSha = crypto
        .createHash("sha256")
        .update("unprovable-reachability")
        .digest("hex");
      server.putObjectDirect(
        "b",
        `p/blobs/sha256/${orphanSha}`,
        Buffer.from("orphan")
      );
      plane.snapshotBlobRoots = async () => {
        throw new Error("cannot read manifest");
      };

      plane.start();
      await expect(
        heldThroughout(
          () => server.hasObjectDirect("b", `p/blobs/sha256/${orphanSha}`),
          250
        )
      ).resolves.toBe(true);
    });
  });
});

async function makeS3List(server: S3TestServer): Promise<string[]> {
  const { S3BlobStore } = await import("@centraid/vault");
  const s3 = new S3BlobStore({
    endpoint: server.url,
    bucket: "b",
    region: "us-east-1",
    prefix: "p",
    credentials: async () => ({
      accessKeyId: "AKIA_TEST",
      secretAccessKey: "secret_test",
    }),
  });
  return s3.list();
}
