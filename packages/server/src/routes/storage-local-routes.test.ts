/*
 * HTTP-level coverage for the local-disk half of the storage routes (issue
 * #544): `GET storage/local` and `GET|PUT storage/limits`. Kept out of
 * `storage-routes.test.ts` because that file is about provider CONNECTIONS
 * and needs a fake provider server; these two need a real directory tree and
 * a real limits file, and nothing else.
 */

import { promises as fs } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";

import { RecoveryKitStateStore } from "../backup/recovery-kit-state.js";
import { openStorageConnectionStore } from "../backup/storage-connections.js";
import { StorageUsagePoller } from "../backup/storage-usage.js";
import type { RouteHandler } from "../serve/build-gateway.js";
import { LocalUsageScanner } from "../serve/local-usage.js";
import { StorageLimitsStore } from "../serve/storage-limits.js";
import type { VaultRegistry } from "../serve/vault-registry.js";
import { makeStorageRouteHandler } from "./storage-routes.js";

const servers: http.Server[] = [];
const dirs: string[] = [];

describe("storage-local-routes", () => {
  afterEach(async () => {
    for (const server of servers.splice(0)) server.close();
    await Promise.all(
      dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
    );
  });

  function startHandlerServer(handler: RouteHandler): Promise<string> {
    const server = http.createServer((req, res) => {
      void handler(req, res).then((owned) => {
        if (!owned) {
          res.statusCode = 404;
          res.end();
        }
      });
    });
    servers.push(server);
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as AddressInfo;
        resolve(`http://127.0.0.1:${port}`);
      });
    });
  }

  async function harness(): Promise<{
    base: string;
    limits: StorageLimitsStore;
    root: string;
  }> {
    const root = await tempDir("centraid-storage-local-routes-");
    dirs.push(root);
    const storageDir = path.join(root, "storage");
    const vaultDir = path.join(root, "vaults", "v1");
    await fs.mkdir(path.join(vaultDir, "blobs"), { recursive: true });
    await fs.writeFile(path.join(vaultDir, "vault.db"), "j".repeat(2048));
    await fs.writeFile(path.join(vaultDir, "blobs", "a.bin"), "b".repeat(4096));

    const storageConnections = await openStorageConnectionStore(storageDir);
    const limits = new StorageLimitsStore(storageDir);
    await limits.load();
    const base = await startHandlerServer(
      makeStorageRouteHandler({
        storageConnections,
        recoveryKit: new RecoveryKitStateStore(storageDir),
        vaults: { planesList: () => [] } as unknown as VaultRegistry,
        storageUsage: new StorageUsagePoller({ storageConnections }),
        localUsage: new LocalUsageScanner({
          rootDir: root,
          vaults: () => [{ vaultId: "v1", name: "Personal", dir: vaultDir }],
          gatewayDirs: () => ({ cache: storageDir }),
          statfs: () => ({ bavail: 500, bsize: 1, blocks: 5000 }),
        }),
        storageLimits: limits,
      })
    );
    return { base, limits, root };
  }

  test("GET storage/local reports per-component bytes, the volume, and the limit evaluation", async () => {
    const { base } = await harness();
    const res = await fetch(`${base}/centraid/_gateway/storage/local`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      totalBytes: number;
      vaults: {
        vaultId: string;
        components: { component: string; bytes: number }[];
      }[];
      components: { component: string }[];
      disk: { freeBytes: number; totalBytes: number };
      limits: { totalLimitBytes: number | null };
      limit: { status: string; fractionUsed: number | null };
    };

    const vault = body.vaults[0]!;
    expect(vault.vaultId).toBe("v1");
    const byComponent = new Map(
      vault.components.map((c) => [c.component, c.bytes])
    );
    expect(byComponent.get("vault-db")).toBe(2048);
    expect(byComponent.get("attachments")).toBe(4096);
    expect(body.components.some((c) => c.component === "cache")).toBe(true);
    expect(body.disk).toStrictEqual({ freeBytes: 500, totalBytes: 5000 });
    // No budget set yet — ok with no fraction, not a fabricated denominator.
    expect(body.limits.totalLimitBytes).toBeNull();
    expect(body.limit).toMatchObject({ status: "ok", fractionUsed: null });
    expect(body.totalBytes).toBeGreaterThanOrEqual(6144);
  });

  test("PUT storage/limits round-trips both limits and clears with null", async () => {
    const { base } = await harness();

    const set = await fetch(`${base}/centraid/_gateway/storage/limits`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        totalLimitBytes: 10 * 1024 ** 3,
        journalLimitBytes: 1024 ** 3,
      }),
    });
    expect(set.status).toBe(200);
    expect(
      ((await set.json()) as { limits: { totalLimitBytes: number } }).limits
    ).toMatchObject({
      totalLimitBytes: 10 * 1024 ** 3,
      journalLimitBytes: 1024 ** 3,
    });

    const read = await fetch(`${base}/centraid/_gateway/storage/limits`);
    expect(
      ((await read.json()) as { limits: { journalLimitBytes: number } }).limits
    ).toMatchObject({
      journalLimitBytes: 1024 ** 3,
    });

    const cleared = await fetch(`${base}/centraid/_gateway/storage/limits`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ totalLimitBytes: null }),
    });
    // Clearing one leaves the other alone — two controls, two PUTs.
    expect(
      ((await cleared.json()) as { limits: Record<string, unknown> }).limits
    ).toMatchObject({
      totalLimitBytes: null,
      journalLimitBytes: 1024 ** 3,
    });
  });

  test("a set budget shows up in the next storage/local evaluation", async () => {
    const { base } = await harness();
    const budget = 256 * 1024 ** 2; // the smallest budget the store accepts
    await fetch(`${base}/centraid/_gateway/storage/limits`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ totalLimitBytes: budget }),
    });

    // `?refresh=1` — the page's Rescan; also the only way to bypass the TTL
    // cache the first GET populated.
    const res = await fetch(
      `${base}/centraid/_gateway/storage/local?refresh=1`
    );
    const body = (await res.json()) as {
      limits: { totalLimitBytes: number };
      limit: {
        status: string;
        limitBytes: number;
        fractionUsed: number | null;
      };
    };
    expect(res.status).toBe(200);
    expect(body.limits.totalLimitBytes).toBe(budget);
    // A fraction only exists once there is a denominator — the ok/degraded/error
    // thresholds themselves are exercised in `storage-limits.test.ts`.
    expect(body.limit).toMatchObject({ status: "ok", limitBytes: budget });
    expect(body.limit.fractionUsed).toBeGreaterThan(0);
  });

  test("a limit below the usable floor is refused with a typed 400", async () => {
    const { base } = await harness();
    const res = await fetch(`${base}/centraid/_gateway/storage/limits`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ journalLimitBytes: 1024 }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: "invalid_journal_limit",
    });
  });

  test("storage/local refuses a non-GET", async () => {
    const { base } = await harness();
    const res = await fetch(`${base}/centraid/_gateway/storage/local`, {
      method: "POST",
    });
    expect(res.status).toBe(405);
  });
});
