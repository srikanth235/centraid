import { promises as fs } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { forEachSequentially } from "@centraid/test-kit/sequential";
import { tempDir } from "@centraid/test-kit/temp-dir";
import {
  bootstrapVault,
  openVaultDb,
  refreshCustodyRollup,
} from "@centraid/vault";
import type { VaultDb } from "@centraid/vault";

import { RecoveryKitStateStore } from "../backup/recovery-kit-state.js";
import { openStorageConnectionStore } from "../backup/storage-connections.js";
import { StorageUsagePoller } from "../backup/storage-usage.js";
import type { RouteHandler } from "../serve/build-gateway.js";
import type { VaultPlane } from "../serve/vault-plane.js";
import type { VaultRegistry } from "../serve/vault-registry.js";
import { makeStorageRouteHandler } from "./storage-routes.js";

const servers: http.Server[] = [];
const cleanups: Array<() => Promise<void> | void> = [];
describe("storage-routes", () => {
  afterEach(async () => {
    for (const server of servers.splice(0)) server.close();
    vi.restoreAllMocks();
    await forEachSequentially(cleanups.splice(0).toReversed(), (cleanup) =>
      cleanup()
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

  async function markKitVerified(store: RecoveryKitStateStore): Promise<void> {
    await store.begin("test-kit-fingerprint");
    await expect(store.verify("test-kit-fingerprint")).resolves.toBeTruthy();
  }

  function startFakeProviderServer(opts: {
    apiKey: string;
    home: boolean;
  }): Promise<string> {
    const server = http.createServer((req, res) => {
      if (req.headers.authorization !== `Bearer ${opts.apiKey}`) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              type: "invalid_request_error",
              code: "auth_expired",
              message: "bad key",
            },
          })
        );
        return;
      }
      if (req.method === "GET" && req.url === "/v1/storage/provider") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            data: {
              protocol: ["centraid-storage-provider/1"],
              dataPlane: "s3",
              capabilities: opts.home
                ? [
                    "backup",
                    "cas",
                    "derived",
                    "usage",
                    "policy",
                    "inventory",
                    "audit",
                  ]
                : ["backup", "cas"],
              ...(opts.home ? { profiles: ["home"] } : {}),
              maxCredentialTtlSeconds: 3600,
              purgeAuthTier: "interactive",
              backup: {
                softDeleteWindowDays: 30,
                retention: {
                  kind: "ladder",
                  keepAllDays: 7,
                  dailyDays: 30,
                  weeklyDays: 90,
                  neverPruneNewest: true,
                },
                restoreCostClass: "free-egress",
                objectLock: true,
                conditionalWrites: true,
              },
              storageClasses: ["STANDARD", "STANDARD_IA"],
            },
          })
        );
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            type: "invalid_request_error",
            code: "not_found",
            message: "no route",
          },
        })
      );
    });
    servers.push(server);
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as AddressInfo;
        resolve(`http://127.0.0.1:${port}`);
      });
    });
  }

  function fakeVaults(): VaultRegistry {
    return { planesList: () => [] } as unknown as VaultRegistry;
  }

  function planeFromDb(name: string, vaultId: string, db: VaultDb): VaultPlane {
    return { name, boot: { vaultId }, db } as unknown as VaultPlane;
  }

  function vaultsFrom(planes: VaultPlane[]): VaultRegistry {
    return { planesList: () => planes } as unknown as VaultRegistry;
  }

  test("POST create refuses without a verified recovery kit and force cannot bypass it", async () => {
    const dir = await tempDir();
    const storageConnections = await openStorageConnectionStore(dir);
    const recoveryKit = new RecoveryKitStateStore(dir);
    const base = await startHandlerServer(
      makeStorageRouteHandler({
        storageConnections,
        recoveryKit,
        vaults: fakeVaults(),
        storageUsage: new StorageUsagePoller({ storageConnections }),
      })
    );

    const apiKey = "sk-provider-super-secret-value";
    const provider = await startFakeProviderServer({ apiKey, home: true });
    const body = {
      kind: "provider",
      name: "Clawgnition home",
      baseUrl: provider,
      apiKey,
    };

    const refused = await fetch(
      `${base}/centraid/_gateway/storage/connections`,
      {
        method: "POST",
        body: JSON.stringify(body),
      }
    );
    expect(refused.status).toBe(409);
    const refusedJson = (await refused.json()) as {
      error: string;
      recoveryKitConfirmed: boolean;
    };
    expect(refusedJson.error).toBe("recovery_kit_not_confirmed");
    expect(refusedJson.recoveryKitConfirmed).toBe(false);
    await expect(storageConnections.list()).resolves.toHaveLength(0);

    const forced = await fetch(
      `${base}/centraid/_gateway/storage/connections`,
      {
        method: "POST",
        body: JSON.stringify({ ...body, force: true }),
      }
    );
    expect(forced.status).toBe(409);
    await expect(forced.json()).resolves.toMatchObject({
      error: "recovery_kit_not_confirmed",
    });
    await expect(storageConnections.list()).resolves.toHaveLength(0);
    await expect(
      fs.readFile(path.join(dir, "gateway.db"), "utf8")
    ).resolves.not.toContain(apiKey);
  });

  test("confirmed recovery kit: create proceeds without force; list/get/patch/delete round-trip", async () => {
    const dir = await tempDir();
    const storageConnections = await openStorageConnectionStore(dir);
    const recoveryKit = new RecoveryKitStateStore(dir);
    await markKitVerified(recoveryKit);
    const onConnectionsChanged = vi.fn<() => Promise<void>>(
      async () => undefined
    );
    const base = await startHandlerServer(
      makeStorageRouteHandler({
        storageConnections,
        recoveryKit,
        vaults: fakeVaults(),
        storageUsage: new StorageUsagePoller({ storageConnections }),
        onConnectionsChanged,
      })
    );

    const apiKey = "sk-provider-secret";
    const provider = await startFakeProviderServer({ apiKey, home: true });
    const created = await fetch(
      `${base}/centraid/_gateway/storage/connections`,
      {
        method: "POST",
        body: JSON.stringify({
          kind: "provider",
          name: "Clawgnition",
          baseUrl: provider,
          apiKey,
        }),
      }
    );
    expect(created.status).toBe(201);
    const { connection } = (await created.json()) as {
      connection: { id: string };
    };

    const list = await fetch(`${base}/centraid/_gateway/storage/connections`);
    expect(
      ((await list.json()) as { connections: unknown[] }).connections
    ).toHaveLength(1);

    const got = await fetch(
      `${base}/centraid/_gateway/storage/connections/${connection.id}`
    );
    expect(got.status).toBe(200);

    const patched = await fetch(
      `${base}/centraid/_gateway/storage/connections/${connection.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ name: "Clawgnition (renamed)" }),
      }
    );
    expect(patched.status).toBe(200);
    const patchedJson = (await patched.json()) as {
      connection: { name: string };
    };
    expect(patchedJson.connection.name).toBe("Clawgnition (renamed)");

    const deleted = await fetch(
      `${base}/centraid/_gateway/storage/connections/${connection.id}`,
      {
        method: "DELETE",
      }
    );
    expect(deleted.status).toBe(200);
    expect((await deleted.json()) as { ok: boolean }).toStrictEqual({
      ok: true,
    });

    const goneAfterDelete = await fetch(
      `${base}/centraid/_gateway/storage/connections/${connection.id}`
    );
    expect(goneAfterDelete.status).toBe(404);
    expect(onConnectionsChanged).toHaveBeenCalledTimes(3);
  });

  test("DELETE an unknown connection 404s", async () => {
    const dir = await tempDir();
    const storageConnections = await openStorageConnectionStore(dir);
    const recoveryKit = new RecoveryKitStateStore(dir);
    const base = await startHandlerServer(
      makeStorageRouteHandler({
        storageConnections,
        recoveryKit,
        vaults: fakeVaults(),
        storageUsage: new StorageUsagePoller({ storageConnections }),
      })
    );
    const res = await fetch(
      `${base}/centraid/_gateway/storage/connections/does-not-exist`,
      {
        method: "DELETE",
      }
    );
    expect(res.status).toBe(404);
  });

  test("GET status answers per-vault shape even with zero mounted vaults", async () => {
    const dir = await tempDir();
    const storageConnections = await openStorageConnectionStore(dir);
    const recoveryKit = new RecoveryKitStateStore(dir);
    const base = await startHandlerServer(
      makeStorageRouteHandler({
        storageConnections,
        recoveryKit,
        vaults: fakeVaults(),
        storageUsage: new StorageUsagePoller({ storageConnections }),
      })
    );
    const res = await fetch(`${base}/centraid/_gateway/storage/status`);
    expect(res.status).toBe(200);
    expect((await res.json()) as { vaults: unknown[] }).toStrictEqual({
      vaults: [],
    });
  });

  test("GET status/events exposes the authenticated custody completion stream", async () => {
    const dir = await tempDir();
    const storageConnections = await openStorageConnectionStore(dir);
    const recoveryKit = new RecoveryKitStateStore(dir);
    const controller = new AbortController();
    const base = await startHandlerServer(
      makeStorageRouteHandler({
        storageConnections,
        recoveryKit,
        vaults: fakeVaults(),
        storageUsage: new StorageUsagePoller({ storageConnections }),
      })
    );

    const res = await fetch(`${base}/centraid/_gateway/storage/status/events`, {
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const first = await res.body!.getReader().read();
    controller.abort();
    expect(new TextDecoder().decode(first.value)).toContain(
      'event: custody\ndata: {"vaults":[]}'
    );
  });

  test("create is rejected when the provider does not advertise the home profile (#436 §1)", async () => {
    const dir = await tempDir();
    const storageConnections = await openStorageConnectionStore(dir);
    const recoveryKit = new RecoveryKitStateStore(dir);
    await markKitVerified(recoveryKit);
    const apiKey = "sk-not-home";
    const provider = await startFakeProviderServer({ apiKey, home: false });
    const base = await startHandlerServer(
      makeStorageRouteHandler({
        storageConnections,
        recoveryKit,
        vaults: fakeVaults(),
        storageUsage: new StorageUsagePoller({ storageConnections }),
      })
    );
    const res = await fetch(`${base}/centraid/_gateway/storage/connections`, {
      method: "POST",
      body: JSON.stringify({
        kind: "provider",
        name: "not-home",
        baseUrl: provider,
        apiKey,
      }),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string; message: string };
    expect(json.error).toBe("provider_not_home_profile");
    expect(json.message).toMatch(/home/u);
    await expect(storageConnections.list()).resolves.toHaveLength(0);
  });

  test("only one home connection can exist at a time (#436 §7)", async () => {
    const dir = await tempDir();
    const storageConnections = await openStorageConnectionStore(dir);
    const recoveryKit = new RecoveryKitStateStore(dir);
    await markKitVerified(recoveryKit);
    const base = await startHandlerServer(
      makeStorageRouteHandler({
        storageConnections,
        recoveryKit,
        vaults: fakeVaults(),
        storageUsage: new StorageUsagePoller({ storageConnections }),
      })
    );
    const create = async (name: string) => {
      const apiKey = `sk-${name}`;
      const provider = await startFakeProviderServer({ apiKey, home: true });
      return fetch(`${base}/centraid/_gateway/storage/connections`, {
        method: "POST",
        body: JSON.stringify({
          kind: "provider",
          name,
          baseUrl: provider,
          apiKey,
        }),
      });
    };
    expect((await create("first")).status).toBe(201);
    const second = await create("second");
    expect(second.status).toBe(409);
    const json = (await second.json()) as { error: string; message: string };
    expect(json.error).toBe("already_exists");
    expect(json.message).toMatch(/only one home connection/u);
  });

  test("GET usage answers an empty list with zero connections", async () => {
    const dir = await tempDir();
    const storageConnections = await openStorageConnectionStore(dir);
    const recoveryKit = new RecoveryKitStateStore(dir);
    const base = await startHandlerServer(
      makeStorageRouteHandler({
        storageConnections,
        recoveryKit,
        vaults: fakeVaults(),
        storageUsage: new StorageUsagePoller({ storageConnections }),
      })
    );
    const res = await fetch(`${base}/centraid/_gateway/storage/usage`);
    expect(res.status).toBe(200);
    expect((await res.json()) as { connections: unknown[] }).toStrictEqual({
      connections: [],
    });
  });

  test("GET usage: a provider connection with no target yet reports providerReported: null with localReplicatedBytes 0 (no vaults mounted)", async () => {
    const dir = await tempDir();
    const storageConnections = await openStorageConnectionStore(dir);
    const recoveryKit = new RecoveryKitStateStore(dir);
    await markKitVerified(recoveryKit);
    const apiKey = "sk-usage";
    const provider = await startFakeProviderServer({ apiKey, home: true });
    const base = await startHandlerServer(
      makeStorageRouteHandler({
        storageConnections,
        recoveryKit,
        vaults: fakeVaults(),
        storageUsage: new StorageUsagePoller({ storageConnections }),
      })
    );
    await fetch(`${base}/centraid/_gateway/storage/connections`, {
      method: "POST",
      body: JSON.stringify({
        kind: "provider",
        name: "My home",
        baseUrl: provider,
        apiKey,
      }),
    });
    const res = await fetch(`${base}/centraid/_gateway/storage/usage`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      connections: {
        connectionId: string;
        kind: string;
        providerReported: unknown;
        localReplicatedBytes: number;
      }[];
    };
    expect(body.connections).toHaveLength(1);
    expect(body.connections[0]?.kind).toBe("provider");
    expect(body.connections[0]?.providerReported).toBeNull();
    expect(body.connections[0]?.localReplicatedBytes).toBe(0);
  });

  interface StatusCacheDTO {
    spoolBytes: number;
    budgetBytes: number | null;
    localHits: number;
    readThroughs: number;
    rangedRemoteReads: number;
    bytesServedLocal: number;
    bytesServedRemote: number;
    evictedBlobs: number;
    evictedBytes: number;
    backpressureEvents: number;
  }

  interface StatusCustodyDTO {
    computedAt: string | null;
    buckets: Record<string, { count: number; bytes: number }>;
  }
  test("GET status carries the #405 §7 cache block per vault; in-memory vault reports an unlimited (null) budget with live spool + hit counters", async () => {
    const dir = await tempDir();
    const storageConnections = await openStorageConnectionStore(dir);
    const recoveryKit = new RecoveryKitStateStore(dir);

    const db = openVaultDb();
    cleanups.push(() => db.close());
    const blob = Buffer.from("cache-metrics-fixture-blob");
    const { sha256 } = db.blobs.ingestSync(blob);
    db.blobs.getSync(sha256); // one local hit — bumps localHits + bytesServedLocal

    const base = await startHandlerServer(
      makeStorageRouteHandler({
        storageConnections,
        recoveryKit,
        vaults: vaultsFrom([planeFromDb("Main", "v1", db)]),
        storageUsage: new StorageUsagePoller({ storageConnections }),
      })
    );

    const res = await fetch(`${base}/centraid/_gateway/storage/status`);
    expect(res.status).toBe(200);
    const out = (await res.json()) as {
      vaults: { vaultId: string; cache: StatusCacheDTO }[];
    };
    const cache = out.vaults[0]?.cache;
    expect(cache).toBeDefined();
    expect(cache?.budgetBytes).toBeNull();
    expect(cache?.spoolBytes).toBe(blob.length);
    expect(cache?.localHits).toBe(1);
    expect(cache?.bytesServedLocal).toBe(blob.length);
    expect(cache?.readThroughs).toBe(0);
    expect(cache?.rangedRemoteReads).toBe(0);
    expect(cache?.bytesServedRemote).toBe(0);
    expect(cache?.evictedBlobs).toBe(0);
    expect(cache?.backpressureEvents).toBe(0);
  });

  // issue #712 B3 — mobile read `blob_custody_state` counts off this route
  // while web read the ROLLUP (`blob.custody_rollup`), so the two clients could
  // disagree about what may be released. The route carries the rollup itself
  // now, and `computedAt` is the load-bearing part: null must reach a client AS
  // null, or the surface renders zeroes as facts.
  test("GET status carries the custody rollup — null computedAt before the sweep, the sweep's own numbers after", async () => {
    const dir = await tempDir();
    const storageConnections = await openStorageConnectionStore(dir);
    const recoveryKit = new RecoveryKitStateStore(dir);
    const db = openVaultDb();
    cleanups.push(() => db.close());
    bootstrapVault(db, { ownerName: "Tester" });
    const base = await startHandlerServer(
      makeStorageRouteHandler({
        storageConnections,
        recoveryKit,
        vaults: vaultsFrom([planeFromDb("Main", "v1", db)]),
        storageUsage: new StorageUsagePoller({ storageConnections }),
      })
    );
    const read = async (): Promise<StatusCustodyDTO> => {
      const res = await fetch(`${base}/centraid/_gateway/storage/status`);
      expect(res.status).toBe(200);
      const out = (await res.json()) as {
        vaults: Array<{ custody: StatusCustodyDTO }>;
      };
      return out.vaults[0]!.custody;
    };

    const before = await read();
    expect(before.computedAt).toBeNull();
    // Both buckets a free-up offer is decided by are present and zeroed, never
    // absent — a client must not have to invent a `?? 0` for either.
    expect(before.buckets.freeable).toStrictEqual({ count: 0, bytes: 0 });
    expect(before.buckets["local-unproven"]).toStrictEqual({
      count: 0,
      bytes: 0,
    });

    const blob = Buffer.from("custody-rollup-fixture-blob");
    const { sha256 } = db.blobs.ingestSync(blob);
    const now = new Date().toISOString();
    db.vault.exec(
      `INSERT INTO core_content_item
         (content_id, media_type, content_uri, sha256, byte_size, created_at)
       VALUES ('content-1', 'image/png', 'blob:sha256:${sha256}', '${sha256}', ${blob.length}, '${now}');
       INSERT INTO blob_custody_state (content_id, sha256, custody_state, checked_at)
       VALUES ('content-1', '${sha256}', 'local-only', '${now}');`
    );
    const written = refreshCustodyRollup(db);

    // Read, never recomputed: rebuilding a whole-library projection per
    // request would be O(vault-size) on the request path.
    const after = await read();
    expect(after.computedAt).toBe(written.computedAt);
    expect(after.buckets["local-only"]).toStrictEqual({
      count: 1,
      bytes: blob.length,
    });
    // No remote tier is configured, so the local copy is UNPROVEN and nothing
    // is freeable — the rollup's safety rule, visible end-to-end on the wire.
    expect(after.buckets["local-unproven"]).toStrictEqual({
      count: 1,
      bytes: blob.length,
    });
    expect(after.buckets.freeable).toStrictEqual({ count: 0, bytes: 0 });
  });

  test("GET status surfaces a real (non-null) budget when blob_cache.budgetBytes is set explicitly", async () => {
    const dir = await tempDir();
    const storageConnections = await openStorageConnectionStore(dir);
    const recoveryKit = new RecoveryKitStateStore(dir);

    const db = openVaultDb();
    cleanups.push(() => db.close());
    bootstrapVault(db, { ownerName: "Tester" });
    db.vault
      .prepare("UPDATE core_vault SET settings_json = ?")
      .run(JSON.stringify({ blob_cache: { budgetBytes: 1_000_000 } }));

    const base = await startHandlerServer(
      makeStorageRouteHandler({
        storageConnections,
        recoveryKit,
        vaults: vaultsFrom([planeFromDb("Main", "v1", db)]),
        storageUsage: new StorageUsagePoller({ storageConnections }),
      })
    );

    const res = await fetch(`${base}/centraid/_gateway/storage/status`);
    const out = (await res.json()) as { vaults: { cache: StatusCacheDTO }[] };
    expect(out.vaults[0]?.cache.budgetBytes).toBe(1_000_000);
  });
});
