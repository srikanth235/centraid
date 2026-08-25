import crypto from "node:crypto";
// Lifecycle over HTTP (#141). No blank-app scaffold (`POST /centraid/_apps`,
// #799) — session/publish laws ride automation create on the same
// `prepareLifecycleSession` + `stageAndMaybePublish` path.
import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, afterEach, beforeEach, expect, test } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";

import type { GatewayPaths } from "../paths.ts";
import { serve } from "../serve/serve.ts";
import type { GatewayServeHandle } from "../serve/serve.ts";
// lifecycle-routes is exercised through serve() HTTP paths below (#545).

let dataDir: string;
let handle: GatewayServeHandle;

function pathsUnder(dir: string): GatewayPaths {
  return {
    vaultDir: path.join(dir, "vault"),
  };
}
/** Active vault's per-app data dir (#280). */
function vaultAppsDir(): string {
  const vaultId = handle.vaults.current().boot.vaultId;
  return path.join(dataDir, "vault", vaultId, "apps");
}

function auth(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${handle.token}`, ...extra };
}

async function listApps(): Promise<
  Array<{ id: string; name?: string; kind?: string }>
> {
  const res = await fetch(`${handle.url}/centraid/_apps`, { headers: auth() });
  expect(res.status).toBe(200);
  return (await res.json()) as Array<{
    id: string;
    name?: string;
    kind?: string;
  }>;
}

async function createApp(
  body: Record<string, unknown>
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${handle.url}/centraid/_automations`, {
    method: "POST",
    headers: auth({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      prompt: "summarize the day",
      triggers: [{ kind: "cron", expr: "0 9 * * *" }],
      ...body,
    }),
  });
  return {
    status: res.status,
    json: (await res.json()) as Record<string, unknown>,
  };
}

async function listSessions(): Promise<string[]> {
  const res = await fetch(`${handle.url}/centraid/_apps/_sessions`, {
    headers: auth(),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { sessions: string[] }).sessions;
}

describe("lifecycle-over-http scenarios", () => {
  beforeEach(async () => {
    dataDir = await tempDir(`gw-lifecycle-${crypto.randomUUID()}-`);
    handle = await serve({
      paths: pathsUnder(dataDir),
      experimental: { automations: true },
    });
  }, 30_000);

  afterEach(async () => {
    await handle?.close().catch(() => undefined);
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  test("POST /_apps/<id>/meta renames an app on main", async () => {
    await createApp({ id: "journal", name: "Journal", publish: true });
    const res = await fetch(`${handle.url}/centraid/_apps/journal/meta`, {
      method: "POST",
      headers: auth({ "Content-Type": "application/json" }),
      body: JSON.stringify({ name: "Daily Journal", publish: true }),
    });
    expect(res.status).toBe(200);
    const row = (await listApps()).find((a) => a.id === "journal");
    expect(row?.name).toBe("Daily Journal");
  });

  test("a bundled app is installed in place, not cloned (issue #434)", async () => {
    // Bundled apps install in place; clone is refused (#434).
    const clone = await fetch(`${handle.url}/centraid/_apps/_clone`, {
      method: "POST",
      headers: auth({ "Content-Type": "application/json" }),
      body: JSON.stringify({ templateId: "tasks", publish: true }),
    });
    expect(clone.status).toBe(409);

    const res = await fetch(`${handle.url}/centraid/_apps/_install`, {
      method: "POST",
      headers: auth({ "Content-Type": "application/json" }),
      body: JSON.stringify({ templateId: "tasks" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { app: { id: string; name?: string } };
    expect(body.app.id).toBe("tasks");
    const row = (await listApps()).find((a) => a.id === "tasks");
    expect(row).toBeDefined();
    expect(row?.kind).toBe("app");
  });

  test("POST /_automations mints a webhook secret and publishes the automation", async () => {
    const res = await fetch(`${handle.url}/centraid/_automations`, {
      method: "POST",
      headers: auth({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        id: "inbound",
        name: "Inbound",
        prompt: "handle the hook",
        triggers: [{ kind: "webhook" }],
        publish: true,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      row: { ownerApp: string } | null;
      webhook?: { id: string; secret: string; url: string };
      staged: boolean;
    };
    expect(body.staged).toBe(false);
    expect(body.row).toBeDefined();
    expect(body.row?.ownerApp).toBe("inbound");
    expect(body.webhook).toBeDefined();
    expect(body.webhook!.secret.length).toBeGreaterThan(0);
    expect(body.webhook!.url).toMatch(/\/_centraid-hook\//u);

    const row = (await listApps()).find((a) => a.id === "inbound");
    expect(row?.kind).toBe("automation");
  });

  test("automation set-enabled then delete flows through publish", async () => {
    await fetch(`${handle.url}/centraid/_automations`, {
      method: "POST",
      headers: auth({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        id: "digest",
        name: "Digest",
        prompt: "summarize",
        triggers: [{ kind: "cron", expr: "0 9 * * *" }],
        enabled: false,
        publish: true,
      }),
    });

    const enable = await fetch(
      `${handle.url}/centraid/_automations/set-enabled?ref=${encodeURIComponent("digest/digest")}`,
      {
        method: "POST",
        headers: auth({ "Content-Type": "application/json" }),
        body: JSON.stringify({ enabled: true, publish: true }),
      }
    );
    expect(enable.status).toBe(200);

    const dataAppDir = path.join(vaultAppsDir(), "digest");
    await fs.mkdir(dataAppDir, { recursive: true });
    await fs.writeFile(path.join(dataAppDir, "data.sqlite"), "rows");

    const del = await fetch(
      `${handle.url}/centraid/_automations?ref=${encodeURIComponent("digest/digest")}&publish=true`,
      { method: "DELETE", headers: auth() }
    );
    expect(del.status).toBe(200);
    const delBody = (await del.json()) as { deletedApp?: boolean };
    expect(delBody.deletedApp).toBe(true);
    expect((await listApps()).some((a) => a.id === "digest")).toBe(false);

    // Delete must not resurrect the data dir via `ensureRegistered`.
    await expect(fs.stat(dataAppDir)).rejects.toThrow(/ENOENT/u);
  });

  test("DELETE /_apps/<id> tears down the app data dir, not just the code", async () => {
    await createApp({ id: "shelf", name: "Shelf", publish: true });
    const dataAppDir = path.join(vaultAppsDir(), "shelf");
    await fs.mkdir(dataAppDir, { recursive: true });
    await fs.writeFile(path.join(dataAppDir, "data.sqlite"), "rows");

    const del = await fetch(`${handle.url}/centraid/_apps/shelf`, {
      method: "DELETE",
      headers: auth(),
    });
    expect(del.status).toBe(200);
    expect((await listApps()).some((a) => a.id === "shelf")).toBe(false);

    await expect(fs.stat(dataAppDir)).rejects.toThrow(/ENOENT/u);
  });

  test("DELETE /_apps/<id> deletes a never-published draft without a no_changes error", async () => {
    const staged = await createApp({ id: "scratch", name: "Scratch" });
    expect(staged.status).toBe(201);
    const dataAppDir = path.join(vaultAppsDir(), "scratch");
    await fs.mkdir(dataAppDir, { recursive: true });
    await fs.writeFile(path.join(dataAppDir, "data.sqlite"), "rows");

    const del = await fetch(`${handle.url}/centraid/_apps/scratch`, {
      method: "DELETE",
      headers: auth(),
    });
    expect(del.status).toBe(200);
    const body = (await del.json()) as {
      deleted: boolean;
      codeRemoved: boolean;
    };
    expect(body.deleted).toBe(true);
    expect(body.codeRemoved).toBe(false);
    await expect(fs.stat(dataAppDir)).rejects.toThrow(/ENOENT/u);

    const again = await fetch(`${handle.url}/centraid/_apps/scratch`, {
      method: "DELETE",
      headers: auth(),
    });
    expect(again.status).toBe(200);
  });

  test("a one-shot publish (no sessionId) closes its lifecycle session — no orphan worktree", async () => {
    const res = await createApp({
      id: "ledger",
      name: "Ledger",
      publish: true,
    });
    expect(res.status).toBe(201);
    expect((await listApps()).some((a) => a.id === "ledger")).toBe(true);
    await expect(listSessions()).resolves.not.toContain("lifecycle-ledger");
  });

  test("an explicit (renderer) editing session is preserved across a publish", async () => {
    await fetch(`${handle.url}/centraid/_apps/_sessions`, {
      method: "POST",
      headers: auth({ "Content-Type": "application/json" }),
      body: JSON.stringify({ sessionId: "desktop-board" }),
    });
    const res = await createApp({
      id: "board",
      name: "Board",
      sessionId: "desktop-board",
      publish: true,
    });
    expect(res.status).toBe(201);
    await expect(listSessions()).resolves.toContain("desktop-board");
  });

  test("a one-shot publish opens fresh off main even when a stale lifecycle session orphan exists", async () => {
    await fetch(`${handle.url}/centraid/_apps/_sessions`, {
      method: "POST",
      headers: auth({ "Content-Type": "application/json" }),
      body: JSON.stringify({ sessionId: "lifecycle-relics" }),
    });
    await expect(listSessions()).resolves.toContain("lifecycle-relics");

    const res = await createApp({
      id: "relics",
      name: "Relics",
      publish: true,
    });
    expect(res.status).toBe(201);
    expect((await listApps()).some((a) => a.id === "relics")).toBe(true);
    await expect(listSessions()).resolves.not.toContain("lifecycle-relics");
  });
});
