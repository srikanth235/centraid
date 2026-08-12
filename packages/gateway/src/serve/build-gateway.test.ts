import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";
// governance: allow-repo-hygiene file-size-limit (#608) cohesive gateway-construction suite shares one production graph harness

import { describe, afterEach, beforeEach, expect, test } from "vitest";

import { ASSISTANT_APP_ID } from "@centraid/app-engine";
import type { RunTurnFn } from "@centraid/app-engine";
import { scaffoldAppFiles } from "@centraid/automation";
import { tempDir } from "@centraid/test-kit/temp-dir";

import type { GatewayPaths } from "../paths.ts";
import { buildGateway } from "./build-gateway.ts";
import type { BuiltGateway } from "./build-gateway.ts";
import { GatewayDatabase } from "./gateway-db.js";
import { configureApiKey, stageItem } from "./outbox-executor-test-kit.js";
import { OwnerStore } from "./owner-store.js";
import type { VaultPlane } from "./vault-plane.js";

// `buildGateway()` is the host-agnostic core: it constructs the whole
// object graph but binds no socket. These tests pin that contract — the
// listener-free shape, plus `composedHandler` dispatching the gateway's
// route chain WITHOUT a bearer check (for hosts that own auth themselves).

let dataDir: string;
let gateway: BuiltGateway;

function pathsUnder(dir: string): GatewayPaths {
  return {
    vaultDir: path.join(dir, "vault"),
  };
}

async function directoryBytes(dir: string): Promise<number> {
  return (
    await Promise.all(
      (
        await fs.readdir(dir, { withFileTypes: true })
      ).map(async (entry) => {
        const target = path.join(dir, entry.name);
        return entry.isDirectory()
          ? directoryBytes(target)
          : (await fs.stat(target)).size;
      })
    )
  ).reduce((total, size) => total + size, 0);
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3_000
): Promise<void> {
  const startedAt = Date.now();
  const waitForNext = async (): Promise<void> => {
    if (predicate()) return;
    if (Date.now() - startedAt > timeoutMs)
      throw new Error("timed out waiting for gateway state");
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    return waitForNext();
  };
  return waitForNext();
}

async function waitForAsync(
  predicate: () => Promise<boolean>,
  timeoutMs = 10_000
): Promise<void> {
  const startedAt = Date.now();
  const waitForNext = async (): Promise<void> => {
    if (await predicate()) return;
    if (Date.now() - startedAt > timeoutMs)
      throw new Error("timed out waiting for gateway state");
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
    return waitForNext();
  };
  return waitForNext();
}

/** Mount a handler on a bare loopback server with no auth in front. */
async function mountUnauthed(
  handler: (
    req: http.IncomingMessage,
    res: http.ServerResponse
  ) => Promise<boolean>
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no bound address");
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
  };
}

describe("build-gateway scenarios", () => {
  beforeEach(async () => {
    dataDir = await tempDir(`build-gateway-${crypto.randomUUID()}-`);
    gateway = await buildGateway({ paths: pathsUnder(dataDir) });
  }, 30_000);

  afterEach(async () => {
    await gateway.stop().catch(() => undefined);
    await fs.rm(dataDir, { recursive: true, force: true });
  }, 30_000);

  test("constructs the graph and exposes the lifecycle without binding a socket", () => {
    expect(gateway.runtime).toBeTruthy();
    expect(gateway.prefs).toBeTruthy();
    expect(gateway.analyticsStore).toBeTruthy();
    expect(gateway.conversationHistoryStore).toBeTruthy();
    expect(gateway.start).toBeTypeOf("function");
    expect(gateway.stop).toBeTypeOf("function");
    expect(Array.isArray(gateway.extraHandlers)).toBeTruthy();
    expect(gateway.composedHandler).toBeTypeOf("function");
    // No listener bound — nothing in the handle resembles a URL/token.
    expect((gateway as unknown as Record<string, unknown>).url).toBeUndefined();
    expect(
      (gateway as unknown as Record<string, unknown>).token
    ).toBeUndefined();
  });

  test("the assistant turn and its auto-title both cross the one accounted harness seam", async () => {
    await gateway.stop();
    const harnessPrompts: string[] = [];
    const injectedRunTurn: RunTurnFn = async (input, config) => {
      harnessPrompts.push(input.message);
      const titleTurn = input.message.includes("First user message:");
      input.onEvent({
        type: "final",
        text: titleTurn ? "Accounted title" : "Primary answer",
      });
      return { harnessKind: config.prefs.kind };
    };
    gateway = await buildGateway({
      paths: pathsUnder(dataDir),
      runTurn: injectedRunTurn,
    });
    gateway.prefs.setPrefs({
      "harness.kind": "codex",
      "model.codex.title": "fast",
    });
    await gateway.start("http://127.0.0.1:0");
    const session =
      gateway.conversationHistoryStore.createSession(ASSISTANT_APP_ID);
    const mounted = await mountUnauthed(gateway.composedHandler);
    try {
      const response = await fetch(
        `${mounted.url}/centraid/_vault/assistant/_turn`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            conversationId: session.id,
            message: "account every harness turn",
          }),
        }
      );
      expect(response.status).toBe(200);
      await response.text();
      await waitForAsync(async () => {
        const runs = (await gateway.health.snapshot()).metrics.resourceUsage
          ?.subsystems.harnessRuns.runs;
        return runs === 2;
      });

      expect(harnessPrompts).toHaveLength(2);
      expect(harnessPrompts[1]).toContain("First user message:");
      expect(
        (await gateway.health.snapshot()).metrics.resourceUsage?.subsystems
          .harnessRuns.runs
      ).toBe(harnessPrompts.length);
    } finally {
      await mounted.close();
    }
  });

  /** Publish one automation app into the gateway's live code store. */
  async function publishAutomation(input: {
    appId: string;
    automationId: string;
    name: string;
    handler: string;
    connector?: { kind: string; label: string };
  }): Promise<void> {
    const store = await gateway.appsStore();
    const sessionId = `seed-${input.appId}`;
    const session = await store.openSession(sessionId);
    await Promise.all(
      scaffoldAppFiles(input.appId, {
        automationId: input.automationId,
        name: input.name,
        triggers: [],
        ...(input.connector
          ? {
              connector: input.connector,
              // A connector manifest must declare the vault access its
              // staged rows land under.
              vault: {
                purpose: "dpv:ServiceProvision",
                why: "stage pulled rows",
                scopes: [{ schema: "sync", verbs: "read+act" }],
              },
            }
          : {}),
      }).map(async (file) => {
        const target = path.join(
          session.worktreePath,
          "apps",
          input.appId,
          file.path
        );
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(
          target,
          file.path.endsWith("/handler.js") ? input.handler : file.content,
          "utf8"
        );
      })
    );
    await store.publish({
      sessionId,
      appId: input.appId,
      message: `seed ${input.appId}`,
    });
    await store.closeSession(sessionId);
    await gateway.syncApps();
  }

  test("a burst of provenance commits collapses into one Notifications recomputation (#647)", async () => {
    const plane = gateway.vaults.current();
    // Instrument the production projection the doorbell samples: every
    // uncoalesced commit would pay a listOutbox scan plus three queries AND
    // ring SSE to every subscriber, which a bulk connector sync repeats per
    // batch.
    const computeSummary = plane.notificationsSummary.bind(plane);
    let summaries = 0;
    plane.notificationsSummary = ((includeArchived?: boolean) => {
      summaries += 1;
      return computeSummary(includeArchived);
    }) as VaultPlane["notificationsSummary"];

    // Each of these is a journalled write commit → one provenance doorbell.
    configureApiKey(plane);
    for (let i = 0; i < 12; i += 1) stageItem(plane);

    // The leading edge fired once; the other twelve commits are still in the
    // window, not twelve more projections.
    expect(summaries).toBe(1);
    // …and the whole burst settles into exactly one trailing recomputation.
    await waitFor(() => summaries > 1);
    expect(summaries).toBe(2);
    expect(plane.blocking().outbox).toHaveLength(12);
  });

  test("a paused connection skips its fire without minting a failure notice (#647)", async () => {
    const appId = "paused-connector";
    const automationId = "pull";
    const automationRef = `${appId}/${automationId}`;
    const plane = gateway.vaults.current();
    const connectionId = configureApiKey(plane);
    const setStatus = (status: string): void => {
      const outcome = plane.gateway.invoke(plane.ownerCredential, {
        command: "sync.set_connection_status",
        input: { connection_id: connectionId, status },
      });
      if (outcome.status !== "executed")
        throw new Error(`set_connection_status: ${JSON.stringify(outcome)}`);
    };
    setStatus("paused");
    await publishAutomation({
      appId,
      automationId,
      name: "Paused pull",
      handler: "export default async () => ({ ran: true });\n",
      connector: { kind: "pull.gmail", label: "personal" },
    });
    await gateway.start("http://127.0.0.1:0");
    const mounted = await mountUnauthed(gateway.composedHandler);
    // A skipped fire never opens a run: the honest-liveness gate returns
    // before the handler executes. A real fire always lands a terminal turn,
    // so the ledger separates "skipped" from "ran".
    interface LedgerTurn {
      endedAt?: number;
      ok?: boolean;
      error?: string;
    }
    const endedTurns = async (): Promise<LedgerTurn[]> => {
      const response = await fetch(
        `${mounted.url}/centraid/_automations/turns?ref=${automationRef}`
      );
      const body = (await response.json()) as { turns?: LedgerTurn[] };
      return (body.turns ?? []).filter((turn) => turn.endedAt !== undefined);
    };
    const fire = async (): Promise<void> => {
      const response = await fetch(
        `${mounted.url}/centraid/_automations/turn-now?ref=${automationRef}`,
        { method: "POST" }
      );
      expect(response.status).toBe(202);
    };
    const notice = (): unknown =>
      gateway.vaults.current().notices.getBySource("automation", automationRef);
    try {
      // A paused connection is owner-chosen state, already carried by its own
      // connection card: every tick skips, and stays silent while it does.
      await fire();
      await fire();
      await new Promise((resolve) => {
        setTimeout(resolve, 1_000);
      });
      await expect(endedTurns()).resolves.toStrictEqual([]);
      // No notice → no severity, no unread reset, no wake.
      expect(notice()).toBeUndefined();

      // Resuming runs for real — which also proves the fires above were
      // skipped by the gate, not lost by the harness. The skip left no
      // stored "failure", so this success announces no recovery either.
      setStatus("active");
      await fire();
      await waitForAsync(async () => (await endedTurns()).length === 1);
      expect((await endedTurns())[0]?.ok).toBe(true);
      expect(notice()).toBeUndefined();
    } finally {
      await mounted.close();
    }
  }, 30_000);

  test("a failed automation fire writes and collapses its Notifications notice", async () => {
    const appId = "broken-run";
    const automationId = "nightly";
    const automationRef = `${appId}/${automationId}`;
    const store = await gateway.appsStore();
    const sessionId = "notifications-failure";
    const session = await store.openSession(sessionId);
    await Promise.all(
      scaffoldAppFiles(appId, {
        automationId,
        name: "Broken nightly",
        triggers: [],
      }).map(async (file) => {
        const target = path.join(
          session.worktreePath,
          "apps",
          appId,
          file.path
        );
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(
          target,
          file.path.endsWith("/handler.js")
            ? "export default async () => { throw new Error('expected automation failure'); };\n"
            : file.content,
          "utf8"
        );
      })
    );
    await store.publish({
      sessionId,
      appId,
      message: "seed failing automation",
    });
    await store.closeSession(sessionId);
    await gateway.syncApps();
    await gateway.start("http://127.0.0.1:0");
    const mounted = await mountUnauthed(gateway.composedHandler);
    const fire = (): Promise<Response> =>
      fetch(
        `${mounted.url}/centraid/_automations/turn-now?ref=${automationRef}`,
        { method: "POST" }
      );
    try {
      expect((await fire()).status).toBe(202);
      await waitFor(
        () =>
          gateway.vaults
            .current()
            .notices.getBySource("automation", automationRef) !== undefined
      );
      expect(
        gateway.vaults
          .current()
          .notices.getBySource("automation", automationRef)
      ).toMatchObject({
        // D4: the headline carries the failure gist, not just "failed".
        headline: "Broken nightly failed — expected automation failure",
        count: 1,
        severity: "high",
        detail: {
          outcome: "failure",
          error: expect.stringContaining("expected automation failure"),
          appId,
          automationId,
        },
      });

      expect((await fire()).status).toBe(202);
      await waitFor(
        () =>
          gateway.vaults
            .current()
            .notices.getBySource("automation", automationRef)?.count === 2
      );
      expect(
        gateway.vaults
          .current()
          .notices.getBySource("automation", automationRef)?.count
      ).toBe(2);
    } finally {
      await mounted.close();
    }
  });

  test("a fresh data dir auto-founds Shared then Personal, and a second boot is a no-op (#603)", async () => {
    await gateway.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
    dataDir = await tempDir(`build-gateway-autofound-${crypto.randomUUID()}-`);
    const dataPlaneSecret = "autofound-data-plane-secret";
    gateway = await buildGateway({
      paths: pathsUnder(dataDir),
      dataPlaneControl: {
        secret: dataPlaneSecret,
        authorize: (endpointId) => ({ allowed: endpointId === "owner-device" }),
        pair: () => ({ ok: false }),
      },
    });
    // Shared is founded FIRST, but the client-facing listing leads with the
    // marked Personal vault (#665) — the same vault the registry hands
    // unscoped callers and unnamed pair tickets. Founding order survives in
    // `planesList()`, which background work iterates.
    expect(gateway.vaults.list().map((v) => v.name)).toStrictEqual([
      "Personal",
      "Shared",
    ]);
    expect(gateway.vaults.list().map((v) => v.personal)).toStrictEqual([
      true,
      undefined,
    ]);
    expect(gateway.vaults.planesList().map((p) => p.name)).toStrictEqual([
      "Shared",
      "Personal",
    ]);
    const founded = gateway.vaults.list().map((v) => v.vaultId);
    expect(gateway.vaults.defaultVaultId()).toBe(founded[0]);
    await expect(directoryBytes(dataDir)).resolves.toBeLessThanOrEqual(
      14 * 1024 ** 2
    );
    await expect(
      fs.access(path.join(dataDir, "gateway.db"))
    ).resolves.toBeUndefined();

    const mounted = await mountUnauthed(gateway.composedHandler);
    try {
      const [info, health, tunnel, tunnelAttacker, status] = await Promise.all([
        fetch(`${mounted.url}/centraid/_gateway/info`),
        fetch(`${mounted.url}/centraid/_gateway/health`),
        fetch(
          `${mounted.url}/centraid/_gateway/tunnel/authorize?endpointId=owner-device`,
          {
            headers: { "x-centraid-data-plane-secret": dataPlaneSecret },
          }
        ),
        fetch(
          `${mounted.url}/centraid/_gateway/tunnel/authorize?endpointId=owner-device`
        ),
        fetch(`${mounted.url}/centraid/_vault/status`),
      ]);
      // No `status` field survives #603 — there is no uninitialized state left.
      const infoBody = (await info.json()) as Record<string, unknown>;
      expect("status" in infoBody).toBe(false);
      expect(infoBody).toMatchObject({ authenticated: false });
      expect(health.status).toBe(200);
      expect(tunnel.status).toBe(200);
      await expect(tunnel.json()).resolves.toStrictEqual({ allowed: true });
      expect(tunnelAttacker.status).toBe(403);
      // The vault plane answers straight away: no 409 wall to clear first.
      expect(status.status).toBe(200);
      // Unscoped → the default vault, which is Personal — and since #665 that
      // is also the head of the listing `founded` was read from.
      await expect(status.json()).resolves.toMatchObject({
        vaultId: founded[0],
      });
    } finally {
      await mounted.close();
    }

    // Rebuilding over the SAME dir must adopt what is there, never re-found.
    await gateway.stop();
    gateway = await buildGateway({ paths: pathsUnder(dataDir) });
    expect(gateway.vaults.list().map((v) => v.vaultId)).toStrictEqual(founded);
    // The `personal` marker is durable, so the remount lists in the same
    // default-first order rather than reverting to founding order (#665).
    expect(gateway.vaults.list().map((v) => v.name)).toStrictEqual([
      "Personal",
      "Shared",
    ]);
  });

  test("an existing data dir with one vault is left exactly as it was found (#603)", async () => {
    await gateway.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
    dataDir = await tempDir(`build-gateway-existing-${crypto.randomUUID()}-`);
    gateway = await buildGateway({ paths: pathsUnder(dataDir) });
    const [shared] = gateway.vaults.list();
    gateway.vaults.delete(gateway.vaults.list()[1]!.vaultId);
    await gateway.stop();

    gateway = await buildGateway({ paths: pathsUnder(dataDir) });
    expect(gateway.vaults.list().map((v) => v.vaultId)).toStrictEqual([
      shared!.vaultId,
    ]);
  });

  test("an inhabited gateway whose vaults were all erased is NOT re-founded (#603)", async () => {
    // Erasing every vault leaves the filesystem registry fresh but keeps the
    // `owners` rows in gateway.db. Restarting the daemon in that state must
    // wait for restore — auto-founding a new Shared + Personal over it would
    // silently bury restore-after-erase.
    for (const vault of gateway.vaults.list()) {
      gateway.vaults.delete(vault.vaultId);
    }
    await gateway.stop();

    gateway = await buildGateway({ paths: pathsUnder(dataDir) });
    expect(gateway.vaults.list()).toStrictEqual([]);
  });

  test("the host that founded the vaults OWNS both (#603, #726)", async () => {
    const founded = gateway.vaults.list().map((v) => v.vaultId);
    expect(founded).toHaveLength(2);
    // Release the gateway's handle before reading gateway.db from outside it.
    await gateway.stop();
    const database = GatewayDatabase.open(dataDir);
    try {
      const rows = database.db
        .prepare(
          "SELECT vault_id, owner_id FROM vault_owners ORDER BY vault_id"
        )
        .all() as Array<{ vault_id: string; owner_id: string }>;
      expect(rows.map((row) => row.vault_id).sort()).toStrictEqual(
        [...founded].sort()
      );
      // ONE owner owns both — a fresh install has no "Unassigned" binding.
      expect(new Set(rows.map((row) => row.owner_id)).size).toBe(1);
      const owners = database.db
        .prepare("SELECT COUNT(*) AS n FROM owners")
        .get() as {
        n: number;
      };
      expect(owners.n).toBe(1);
    } finally {
      database.close();
    }
  });

  // Exit evidence #4 (#726 P1): founding still auto-creates Shared+Personal
  // owned by the founding owner (covered above), AND a fresh boot after the
  // household-migration sweep mints no extra vaults.
  test("household migration mints a vault for every ownerless owner, once (#726 P1)", async () => {
    const foundedCount = gateway.vaults.list().length;
    expect(foundedCount).toBe(2);
    // Release the gateway's exclusive lock before touching gateway.db directly.
    await gateway.stop();

    // A person record with no vault — the shape P0's admin-fallback migration
    // or the bare host-custody `POST /owners` lane can leave behind.
    let strandedOwnerId: string;
    {
      const database = GatewayDatabase.open(dataDir);
      try {
        strandedOwnerId =
          OwnerStore.open(database).create("Widowed Account").ownerId;
      } finally {
        database.close();
      }
    }

    // Reboot: the migration sweep runs once, at boot, for every ownerless
    // owner — this one gets "<label>'s vault" minted on THIS machine.
    gateway = await buildGateway({ paths: pathsUnder(dataDir) });
    const afterMigration = gateway.vaults.list();
    expect(afterMigration).toHaveLength(foundedCount + 1);
    expect(afterMigration.map((v) => v.name)).toContain(
      "Widowed Account's vault"
    );
    await gateway.stop();
    {
      const database = GatewayDatabase.open(dataDir);
      try {
        expect(
          OwnerStore.open(database).vaultsOwnedBy(strandedOwnerId)
        ).toHaveLength(1);
      } finally {
        database.close();
      }
    }

    // A second boot after migration mints NOTHING extra — the guard is
    // "does this owner own a vault yet", re-evaluated, not a one-shot flag.
    gateway = await buildGateway({ paths: pathsUnder(dataDir) });
    expect(gateway.vaults.list()).toHaveLength(foundedCount + 1);
  });

  test("network filesystem detection warns without refusing and disables orphan deletion", async () => {
    await gateway.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
    dataDir = await tempDir(`build-gateway-network-fs-${crypto.randomUUID()}-`);
    const database = GatewayDatabase.open(dataDir, {
      lock: "exclusive",
      networkFileSystem: true,
    });
    gateway = await buildGateway({
      paths: pathsUnder(dataDir),
      gatewayDatabase: database,
    });

    const snapshot = await gateway.health.snapshot();
    expect(snapshot.components).toContainEqual(
      expect.objectContaining({
        component: "filesystem",
        status: "degraded",
        detail: expect.stringMatching(
          /network filesystem.*orphan blob deletion is disabled/iu
        ),
      })
    );
    const plane = gateway.vaults.current() as unknown as {
      skipOrphanDelete: () => boolean;
    };
    expect(plane.skipOrphanDelete()).toBe(true);
  });

  test("mounts the vault registry and recovers it across rebuilds (#280)", async () => {
    // The registry is mandatory now — the whole app world is vault-scoped.
    expect(gateway.vaults).toBeDefined();
    expect(gateway.vaults.current().boot.fresh).toBe(true);
    expect(gateway.vaults.list()).toHaveLength(2);
    // The owner consent surface answers through the composed chain.
    const mounted = await mountUnauthed(gateway.composedHandler);
    try {
      const status = await (
        await fetch(`${mounted.url}/centraid/_vault/status`)
      ).json();
      expect(status).toMatchObject({
        vaultId: gateway.vaults.current().boot.vaultId,
      });
    } finally {
      await mounted.close();
    }

    // A stopped gateway releases gateway.db; a rebuild recovers the same
    // vault and WAL ownership is unconditional after the lease deletion.
    const vaultId = gateway.vaults.current().boot.vaultId;
    expect(gateway.vaults.current().walShipper).toBeDefined();
    await gateway.stop();
    gateway = await buildGateway({ paths: pathsUnder(dataDir) });
    expect(gateway.vaults.current().boot.fresh).toBe(false);
    expect(gateway.vaults.current().boot.vaultId).toBe(vaultId);
    expect(gateway.vaults.current().walShipper).toBeDefined();
  });

  test("the active vault owns a code store — activeAppsStore materializes it", async () => {
    const store = await gateway.appsStore();
    expect(store).toBeTruthy();
    // The store lives INSIDE the active vault's directory (#280).
    const vaultId = gateway.vaults.current().boot.vaultId;
    expect(
      store
        .getActiveMainLink()
        .startsWith(path.join(dataDir, "vault", vaultId, "code"))
    ).toBe(true);
  });

  test("composedHandler dispatches runtime routes with NO bearer check", async () => {
    await gateway.start("http://127.0.0.1:0");
    const srv = await mountUnauthed(gateway.composedHandler);
    try {
      // No Authorization header — a fronting host owns auth itself, so
      // the composed chain must serve the request, not 401 it.
      const res = await fetch(`${srv.url}/centraid/_apps`);
      expect(res.status).toBe(200);
      // The mounted vault's bundled roster (#708) — what is under test is that
      // the chain SERVED the route rather than 401'd it.
      const body = (await res.json()) as { id: string }[];
      expect(body.map((a) => a.id)).toContain("tasks");
    } finally {
      await srv.close();
    }
  });

  test("production route table reaches both tunnel controls and the OAuth callback", async () => {
    await gateway.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
    dataDir = await tempDir(`build-gateway-routes-${crypto.randomUUID()}-`);
    const secret = "compiled-route-secret";
    gateway = await buildGateway({
      paths: pathsUnder(dataDir),
      dataPlaneControl: {
        secret,
        authorize: (endpointId) => ({ allowed: endpointId === "device-a" }),
        pair: (request, endpointId) => ({ ok: true, endpointId, request }),
      },
    });
    const srv = await mountUnauthed(gateway.composedHandler);
    try {
      const authorize = await fetch(
        `${srv.url}/centraid/_gateway/tunnel/authorize?endpointId=device-a`,
        { headers: { "x-centraid-data-plane-secret": secret } }
      );
      expect(authorize.status).toBe(200);
      await expect(authorize.json()).resolves.toStrictEqual({ allowed: true });

      const pair = await fetch(
        `${srv.url}/centraid/_gateway/tunnel/pair?endpointId=device-a`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-centraid-data-plane-secret": secret,
          },
          body: JSON.stringify({ ticketId: "ticket-a" }),
        }
      );
      expect(pair.status).toBe(200);
      await expect(pair.json()).resolves.toMatchObject({
        ok: true,
        endpointId: "device-a",
      });

      const callback = await fetch(
        `${srv.url}/centraid/_vault/oauth/callback?error=access_denied`
      );
      expect(callback.status).toBe(400);
      await expect(callback.text()).resolves.toContain("Not connected");
    } finally {
      await srv.close();
    }
  });

  test("composedHandler routes the chat-history + prefs prefixes", async () => {
    await gateway.start("http://127.0.0.1:0");
    const srv = await mountUnauthed(gateway.composedHandler);
    try {
      // Both prefixes resolve to their store handlers (not the runtime
      // fall-through) — proving the chat → prefs → extra → runtime order.
      const chat = await fetch(`${srv.url}/_centraid-user/prefs`);
      expect(chat.status).not.toBe(404);
      // `/id` answers with the ACTIVE vault's owner party id (#280).
      const id = (await (
        await fetch(`${srv.url}/_centraid-user/id`)
      ).json()) as { id: string };
      expect(id.id).toBe(gateway.vaults.current().boot.ownerPartyId);
    } finally {
      await srv.close();
    }
  });

  test("composedHandler serves the kit Ask panel model picker (GET/PUT /centraid/<appId>/_turn/model)", async () => {
    await gateway.start("http://127.0.0.1:0");
    await gateway.runtime.registry.ensureUploaded("demo");
    const srv = await mountUnauthed(gateway.composedHandler);
    try {
      // No override yet — `current` is null, no defaultModel (no prefs, no
      // catalog in this hermetic test — the CLI probe/warmer never runs).
      const before = (await (
        await fetch(`${srv.url}/centraid/demo/_turn/model`)
      ).json()) as {
        harnessKind: string;
        current: string | null;
        catalog: unknown[];
      };
      expect(before.harnessKind).toBe("codex"); // prefsLoader's default when unset
      expect(before.current).toBeNull();
      expect(before.catalog).toStrictEqual([]);

      // Setting the override writes the SAME `model.<kind>.ask` prefs key
      // `resolveSubsystemModel` reads at turn time — one source of truth.
      const putRes = await fetch(`${srv.url}/centraid/demo/_turn/model`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.5-mini" }),
      });
      expect(putRes.status).toBe(200);
      expect(gateway.prefs.getAllPrefs()["model.codex.ask"]).toBe(
        "gpt-5.5-mini"
      );

      const after = (await (
        await fetch(`${srv.url}/centraid/demo/_turn/model`)
      ).json()) as {
        current: string | null;
      };
      expect(after.current).toBe("gpt-5.5-mini");

      // `model: null` clears the override back to default.
      const cleared = await fetch(`${srv.url}/centraid/demo/_turn/model`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: null }),
      });
      expect(
        ((await cleared.json()) as { current: string | null }).current
      ).toBeNull();
      expect(gateway.prefs.getAllPrefs()["model.codex.ask"]).toBeUndefined();
    } finally {
      await srv.close();
    }
  });

  test("the ask model picker follows ask’s OWN harness pin, not the default harness", async () => {
    await gateway.start("http://127.0.0.1:0");
    await gateway.runtime.registry.ensureUploaded("demo");
    const srv = await mountUnauthed(gateway.composedHandler);
    try {
      // The default harness stays codex; only the `ask` register is re-pinned.
      gateway.prefs.setPrefs({
        "harness.kind": "codex",
        "harness.ask": "claude-code",
      });

      // GET reports ask's resolved harness — the picker must offer the models of
      // the backend the ask turn will actually run on.
      const info = (await (
        await fetch(`${srv.url}/centraid/demo/_turn/model`)
      ).json()) as {
        harnessKind: string;
      };
      expect(info.harnessKind).toBe("claude-code");

      // ...and PUT writes THAT harness's key. Reading one key while writing
      // another is the exact bug per-subsystem resolution has to avoid.
      const putRes = await fetch(`${srv.url}/centraid/demo/_turn/model`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4-6" }),
      });
      expect(putRes.status).toBe(200);
      expect(gateway.prefs.getAllPrefs()["model.claude-code.ask"]).toBe(
        "claude-sonnet-4-6"
      );
      // The default harness's key is untouched — no cross-harness bleed.
      expect(gateway.prefs.getAllPrefs()["model.codex.ask"]).toBeUndefined();

      // The round-trip agrees: GET reads back what PUT wrote.
      const after = (await (
        await fetch(`${srv.url}/centraid/demo/_turn/model`)
      ).json()) as {
        current: string | null;
      };
      expect(after.current).toBe("claude-sonnet-4-6");
    } finally {
      await srv.close();
    }
  });

  test("with no harness.* pins the ask picker still rides the default harness (back-compat)", async () => {
    await gateway.start("http://127.0.0.1:0");
    await gateway.runtime.registry.ensureUploaded("demo");
    const srv = await mountUnauthed(gateway.composedHandler);
    try {
      // Back-compat is the hard requirement: a prefs file that predates
      // per-subsystem selection carries only `harness.kind`, and every
      // register must resolve to it exactly as it did before.
      gateway.prefs.setPrefs({ "harness.kind": "claude-code" });

      const info = (await (
        await fetch(`${srv.url}/centraid/demo/_turn/model`)
      ).json()) as {
        harnessKind: string;
      };
      expect(info.harnessKind).toBe("claude-code");
    } finally {
      await srv.close();
    }
  });

  test("start() activates the vault workspace so its apps dir exists", async () => {
    await gateway.start("http://127.0.0.1:0");
    const vaultId = gateway.vaults.current().boot.vaultId;
    const stat = await fs.stat(path.join(dataDir, "vault", vaultId, "apps"));
    expect(stat.isDirectory()).toBeTruthy();
  });

  test("serves component health through the composed chain", async () => {
    await gateway.start("http://127.0.0.1:0");
    // Host-pushed components (e.g. the desktop tunnel) join the aggregate.
    gateway.health.reportError("tunnel", "iroh endpoint dial failed");
    const srv = await mountUnauthed(gateway.composedHandler);
    try {
      const body = (await (
        await fetch(`${srv.url}/centraid/_gateway/health`)
      ).json()) as {
        status: string;
        components: Array<{
          component: string;
          status: string;
          detail?: string;
        }>;
        recentEvents: Array<{
          component: string;
          level: string;
          message: string;
        }>;
      };
      expect(body.status).toBe("error");
      const byName = new Map(body.components.map((c) => [c.component, c]));
      // Wired-in probes: the boot vault mounted, no connections configured.
      expect(byName.get("vaults")).toMatchObject({
        status: "ok",
        detail: "2 vaults mounted",
      });
      expect(byName.get("connections")).toMatchObject({ status: "ok" });
      // Reconcile ran during start() and reported the scheduler healthy.
      expect(byName.get("automations")?.status).toBe("ok");
      // Bundled enricher templates are installed disabled by default on the
      // boot vault; health reports the full installed set while showing none
      // enabled. No s3 tier is configured, and both remain honest ok states.
      expect(byName.get("enrichment")).toMatchObject({
        status: "ok",
        detail: "0 of 10 enrichers enabled",
      });
      expect(byName.get("blob-sweep")?.status).toBe("ok");
      // The host-pushed failure carries its structured event.
      expect(byName.get("tunnel")).toMatchObject({
        status: "error",
        lastError: "iroh endpoint dial failed",
      });
      expect(body.recentEvents).toContainEqual(
        expect.objectContaining({ component: "tunnel", level: "error" })
      );
    } finally {
      await srv.close();
    }
  });

  test("the disk component reports free space on the vault volume", async () => {
    await gateway.start("http://127.0.0.1:0");
    const srv = await mountUnauthed(gateway.composedHandler);
    try {
      const body = (await (
        await fetch(`${srv.url}/centraid/_gateway/health`)
      ).json()) as {
        components: Array<{
          component: string;
          status: string;
          detail?: string;
        }>;
      };
      const disk = body.components.find((c) => c.component === "disk");
      // The host volume may legitimately be degraded/error under the shipped
      // percent + absolute thresholds. The classifier's deterministic status
      // cases live in disk-health.test.ts; this integration test owns wiring.
      expect(disk).toBeDefined();
      expect(disk?.detail).toContain("free of");
      expect(disk?.detail).toMatch(/\(\d+\.\d% free\)/u);
    } finally {
      await srv.close();
    }
  });

  test("the vaults probe proves readability — a broken DB handle flips it to error, named by vault id (#351)", async () => {
    await gateway.start("http://127.0.0.1:0");
    const plane = gateway.vaults.current();
    const vaultId = plane.boot.vaultId;
    // Simulate the file becoming unreadable underneath the process (disk
    // failure, external corruption) WITHOUT actually closing the handle —
    // that would double-close on teardown. The plane object stays "mounted"
    // in memory; only the trivial read the probe runs now fails.
    (plane.db.vault as unknown as { prepare: () => never }).prepare = () => {
      throw new Error("database disk image is malformed");
    };
    const srv = await mountUnauthed(gateway.composedHandler);
    try {
      const body = (await (
        await fetch(`${srv.url}/centraid/_gateway/health`)
      ).json()) as {
        status: string;
        components: Array<{
          component: string;
          status: string;
          detail?: string;
        }>;
      };
      const vaults = body.components.find((c) => c.component === "vaults");
      expect(vaults?.status).toBe("error");
      expect(vaults?.detail).toContain(vaultId);
      expect(body.status).toBe("error");
    } finally {
      await srv.close();
    }
  });
});
