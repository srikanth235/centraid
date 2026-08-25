import crypto from "node:crypto";
import path from "node:path";
/*
 * End-to-end coverage for #367 §C — the vault blob CAS's S3-compatible
 * remote tier — against a REAL S3-compatible HTTP server (`S3TestServer`):
 * real SigV4 over real sockets, real AES-256-GCM sealing; assertions read
 * back through the client or the server's direct object map. Covers
 * round-trip incl. multipart (§C8), replication + sealed-object verification
 * (§C3/C4), reconcile orphan deletion, lease-gate skip (§C6), rotation reset
 * (§C9).
 */
import { Readable } from "node:stream";

import { afterAll, describe, expect, test, vi } from "vitest";

import { S3TestServer } from "@centraid/backup/dist/testing/s3-test-server.js";
import { forEachSequentially } from "@centraid/test-kit/sequential";
import { tempDir } from "@centraid/test-kit/temp-dir";
import {
  BlobCustody,
  FsBlobStore,
  MULTIPART_THRESHOLD_BYTES,
  S3BlobStore,
  ephemeralSealKey,
  sealBlob,
  sealBlobStream,
  unsealBlob,
} from "@centraid/vault";
import type { RemoteTier } from "@centraid/vault";

vi.setConfig({ testTimeout: 30_000 });

const cleanups: Array<() => Promise<void> | void> = [];
describe("storage", () => {
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

  const BUCKET = "test-bucket";
  const CREDS = { accessKeyId: "AKIA_TEST", secretAccessKey: "secret_test" };

  function makeS3(
    server: S3TestServer,
    prefix: string,
    opts: { throttleBytesPerSec?: number } = {}
  ): S3BlobStore {
    return new S3BlobStore({
      endpoint: server.url,
      bucket: BUCKET,
      region: "us-east-1",
      prefix,
      credentials: async () => CREDS,
      ...opts,
    });
  }

  describe("S3BlobStore round-trip (real server, incl. multipart)", () => {
    test("small blob: single PUT round-trips byte-exact", async () => {
      const server = await startServer();
      const s3 = makeS3(server, "vault1");
      const bytes = crypto.randomBytes(4096);
      const sha = crypto.createHash("sha256").update(bytes).digest("hex");
      await s3.put(sha, bytes);
      const back = await s3.get(sha);
      expect(back?.equals(bytes)).toBe(true);
      await expect(s3.list()).resolves.toStrictEqual([sha]);
    });

    test("large blob (> MULTIPART_THRESHOLD_BYTES): putStream drives real multipart and round-trips byte-exact", async () => {
      const server = await startServer();
      const s3 = makeS3(server, "vault1");
      const size = MULTIPART_THRESHOLD_BYTES + 5 * 1024 * 1024; // force multipart
      const bytes = crypto.randomBytes(size);
      const sha = crypto.createHash("sha256").update(bytes).digest("hex");

      await s3.putStream(sha, Readable.from([bytes]), size);

      // Prove multipart ran, not a silent single-PUT fallback.
      const initiated = server.requests.some(
        (r) => r.method === "POST" && r.path.includes("uploads")
      );
      const partPuts = server.requests.filter(
        (r) => r.method === "PUT" && r.path.includes("partNumber")
      );
      const completed = server.requests.some(
        (r) =>
          r.method === "POST" &&
          r.path.includes("uploadId") &&
          !r.path.includes("uploads")
      );
      expect(initiated).toBe(true);
      expect(partPuts.length).toBeGreaterThanOrEqual(2);
      expect(completed).toBe(true);

      const back = await s3.get(sha);
      expect(back?.length).toBe(size);
      expect(back?.equals(bytes)).toBe(true);
    });

    test("putStream below the threshold falls back to a single PUT (no multipart calls)", async () => {
      const server = await startServer();
      const s3 = makeS3(server, "vault1");
      const bytes = crypto.randomBytes(1024);
      const sha = crypto.createHash("sha256").update(bytes).digest("hex");
      await s3.putStream(sha, Readable.from([bytes]), bytes.length);
      expect(server.requests.some((r) => r.path.includes("uploads"))).toBe(
        false
      );
      const back = await s3.get(sha);
      expect(back?.equals(bytes)).toBe(true);
    });
  });

  describe("BlobCustody replication against a real S3-compatible server", () => {
    async function makeCustody(
      server: S3TestServer,
      dir: string,
      prefix: string
    ) {
      const local = new FsBlobStore(path.join(dir, "blobs"));
      const sealKey = ephemeralSealKey();
      const remote = (): RemoteTier | null => ({
        store: makeS3(server, prefix),
        encryptKey: sealKey,
      });
      return { custody: new BlobCustody(local, remote), local, sealKey };
    }

    test("replicate() seals remote objects — raw bytes on the wire are ciphertext, not plaintext", async () => {
      const server = await startServer();
      const dir = await tempDir("custody-seal");
      const { custody, sealKey } = await makeCustody(server, dir, "vaultA");

      const plaintext = Buffer.from(
        "the quick brown fox jumps over the lazy dog"
      );
      const { sha256: sha } = custody.ingestSync(plaintext);

      const moved = await custody.replicate([sha]);
      expect(moved).toStrictEqual([sha]);

      // Raw bytes off the server's object map, not the client's unseal path.
      const raw = server.getObjectDirect(BUCKET, `vaultA/blobs/sha256/${sha}`);
      expect(raw).toBeDefined();
      expect(raw!.equals(plaintext)).toBe(false); // NOT plaintext on the wire
      expect(raw!).not.toContain(plaintext); // not even a plaintext substring

      const unsealed = unsealBlob(sealKey, sha, raw!);
      expect(unsealed.equals(plaintext)).toBe(true); // but it decrypts back correctly
    });

    test("reconcile() replicates missing shas and deletes remote orphans", async () => {
      const server = await startServer();
      const dir = await tempDir("custody-reconcile");
      const { custody } = await makeCustody(server, dir, "vaultC");

      const { sha256: liveSha } = custody.ingestSync(
        Buffer.from("live content")
      );
      // Orphan: seeded remotely, no local claim, not in the live set.
      const orphanSha = crypto
        .createHash("sha256")
        .update("orphan")
        .digest("hex");
      server.putObjectDirect(
        BUCKET,
        `vaultC/blobs/sha256/${orphanSha}`,
        Buffer.from("orphan bytes")
      );

      const result = await custody.reconcile(new Set([liveSha]));
      expect(result.replicated).toContain(liveSha);
      expect(result.orphansDeleted).toContain(orphanSha);
      expect(result.orphansSkipped).toStrictEqual([]);
      expect(
        server.hasObjectDirect(BUCKET, `vaultC/blobs/sha256/${orphanSha}`)
      ).toBe(false);
    });

    test("lease-gated reconcile (skipOrphanDelete) leaves orphans in place and reports them", async () => {
      const server = await startServer();
      const dir = await tempDir("custody-lease-gate");
      const { custody } = await makeCustody(server, dir, "vaultD");

      const orphanSha = crypto
        .createHash("sha256")
        .update("lease-gate-orphan")
        .digest("hex");
      server.putObjectDirect(
        BUCKET,
        `vaultD/blobs/sha256/${orphanSha}`,
        Buffer.from("orphan bytes")
      );

      const result = await custody.reconcile(new Set(), {
        skipOrphanDelete: true,
      });
      expect(result.orphansDeleted).toStrictEqual([]);
      expect(result.orphansSkipped).toContain(orphanSha);
      // Still there — a conflicted gateway must never delete the other's live write.
      expect(
        server.hasObjectDirect(BUCKET, `vaultD/blobs/sha256/${orphanSha}`)
      ).toBe(true);

      // Lease conflict cleared: a normal reconcile finishes the job.
      const cleared = await custody.reconcile(new Set());
      expect(cleared.orphansDeleted).toContain(orphanSha);
    });

    test("endpoint/bucket rotation (issue #367 §C9): old prefix untouched, new prefix starts empty and re-replicates", async () => {
      const server = await startServer();
      const dir = await tempDir("custody-rotate");
      const local = new FsBlobStore(path.join(dir, "blobs"));
      const sealKey = ephemeralSealKey();

      let currentPrefix = "vaultE-old";
      const remote = (): RemoteTier => ({
        store: makeS3(server, currentPrefix),
        encryptKey: sealKey,
      });
      const custody = new BlobCustody(local, remote);

      const { sha256: sha } = custody.ingestSync(Buffer.from("rotated blob"));
      await custody.replicate([sha]);
      await expect(makeS3(server, "vaultE-old").list()).resolves.toStrictEqual([
        sha,
      ]);

      // Rotate at the `remoteTier()` seam — what a real caller does in settings.
      currentPrefix = "vaultE-new";

      // Old prefix untouched — nothing addresses it again.
      expect(
        server.hasObjectDirect(BUCKET, "vaultE-old/blobs/sha256/" + sha)
      ).toBe(true);

      // New prefix is empty: reconcile must read the sha as local-only and
      // replicate fresh, never treating the old remote copy as coverage.
      const before = await custody.statusFor([sha]);
      expect(before.get(sha)).toBe("local-only");
      const result = await custody.reconcile(new Set([sha]));
      expect(result.replicated).toContain(sha);
      await expect(makeS3(server, "vaultE-new").list()).resolves.toStrictEqual([
        sha,
      ]);
    });

    test("sealBlob/sealBlobStream produce the same framed wire shape (modulo per-frame nonces) and both round-trip through unsealBlob", async () => {
      // Issue #405 §1: the seal is FRAMED (CBSF header, per-frame GCM
      // `nonce|ct|tag` + `[algoId]`, trailer). The buffered and streaming
      // sealers implement ONE format: identical lengths (only nonces differ,
      // compression verdicts deterministic), both must round-trip.
      const key = ephemeralSealKey();
      const sha = crypto
        .createHash("sha256")
        .update("stream-vs-buffer")
        .digest("hex");
      // Multiple frames at a small frame size with an odd tail, incompressible
      // so both paths store frames verbatim at equal lengths.
      const frameSize = 64 * 1024;
      const plaintext = crypto.randomBytes(frameSize * 3 + 777);

      const buffered = sealBlob(key, sha, plaintext, frameSize);

      const chunks: Buffer[] = [];
      const transform = sealBlobStream(key, sha, plaintext.length, frameSize);
      const source = Readable.from(chunkEvery(plaintext, 7 * 1024)); // awkward chunk size
      await new Promise<void>((resolve, reject) => {
        source
          .pipe(transform)
          .on("data", (c: Buffer) => chunks.push(c))
          .on("end", () => resolve())
          .on("error", reject);
      });
      const streamed = Buffer.concat(chunks);

      // Same wire shape: identical total length (nonce size fixed, count invariant).
      expect(streamed).toHaveLength(buffered.length);
      // Both decrypt back; sealed bytes differ because nonces differ.
      expect(unsealBlob(key, sha, buffered).equals(plaintext)).toBe(true);
      expect(unsealBlob(key, sha, streamed).equals(plaintext)).toBe(true);
    });
  });
});

function* chunkEvery(buf: Buffer, size: number): Generator<Buffer> {
  for (let i = 0; i < buf.length; i += size)
    yield buf.subarray(i, Math.min(i + size, buf.length));
}
