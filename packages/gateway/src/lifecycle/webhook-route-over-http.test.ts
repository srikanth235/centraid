import crypto from "node:crypto";
/*
 * Webhook-trigger route on the CORE gateway (issue #96). The desktop/daemon
 * gateway (`serve()`) IS the always-on host for desktop-only users — a
 * `webhook` trigger must fire there directly. This boots a real
 * gateway, creates a webhook-triggered automation over the lifecycle HTTP
 * API (the desktop's real path — see `lifecycle-over-http.test.ts` for the
 * create-side assertions), then drives `/_centraid-hook/<id>` itself:
 * the shared secret is the whole auth story (no gateway owner bearer),
 * a wrong secret 401s, and an unknown id 404s.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, afterEach, beforeEach, expect, test, vi } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";

import type { GatewayPaths } from "../paths.ts";
import { serve } from "../serve/serve.ts";
import type { GatewayServeHandle } from "../serve/serve.ts";

let dataDir: string;
let handle: GatewayServeHandle;

function pathsUnder(dir: string): GatewayPaths {
  return {
    vaultDir: path.join(dir, "vault"),
  };
}

function auth(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${handle.token}`, ...extra };
}

/** The DEFAULT vault's journal — a gateway auto-founds two of them (#603). */
async function journalDbPath(): Promise<string> {
  const vaultId = handle.vaults.defaultVaultId();
  const entries = await fs.readdir(dataDir, { recursive: true });
  const relative = entries.find(
    (entry) => entry.endsWith("journal.db") && entry.includes(vaultId)
  );
  if (!relative)
    throw new Error(`journal.db for vault ${vaultId} was not created`);
  return path.join(dataDir, relative);
}

async function openSession(sessionId: string): Promise<void> {
  const res = await fetch(`${handle.url}/centraid/_apps/_sessions`, {
    method: "POST",
    headers: auth({ "Content-Type": "application/json" }),
    body: JSON.stringify({ sessionId }),
  });
  expect(res.status).toBe(201);
}

async function putFile(
  appId: string,
  sessionId: string,
  relPath: string,
  content: string
): Promise<void> {
  const res = await fetch(
    `${handle.url}/centraid/_apps/${appId}/files/${relPath
      .split("/")
      .map(encodeURIComponent)
      .join("/")}?sessionId=${sessionId}`,
    { method: "PUT", headers: auth(), body: content }
  );
  expect(res.status).toBe(200);
}

async function publish(
  appId: string,
  sessionId: string,
  message: string
): Promise<void> {
  const res = await fetch(`${handle.url}/centraid/_apps/${appId}/publish`, {
    method: "POST",
    headers: auth({ "Content-Type": "application/json" }),
    body: JSON.stringify({ sessionId, message }),
  });
  expect(res.status).toBe(201);
}

/**
 * Create + publish a webhook-triggered automation over the real lifecycle
 * API (`POST /centraid/_automations`), then swap the scaffolded DRAFT
 * handler for a trivial one with no `ctx.agent` call.
 *
 * WHY: `runFire` opens the dispatch surface per fire
 * (`packages/automation/src/fire/fire.ts`), but that surface is inert until a
 * `ctx.agent` call routes a real model turn through the configured agent CLI
 * — "a fire whose handler never calls ctx.agent starts zero child processes."
 * The scaffolded DEFAULT_HANDLER calls ctx.agent, which would make this test's
 * outcome depend on whatever codex/claude CLI happens to be on the test
 * runner's PATH (or hang). Swapping in a handler with no `ctx.agent` keeps the
 * fire hermetic while still exercising the REAL webhook auth, cross-vault
 * resolution, durable ingress, cursor advance, and asynchronous fire path
 * end to end — only the handler body is a stand-in.
 */
async function createWebhookAutomation(
  appId: string
): Promise<{ id: string; secret: string; ref: string }> {
  const res = await fetch(`${handle.url}/centraid/_automations`, {
    method: "POST",
    headers: auth({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      id: appId,
      name: appId,
      prompt: "fire on inbound webhook",
      triggers: [{ kind: "webhook" }],
      publish: true,
    }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as {
    row?: { ref: string };
    webhook?: { id: string; secret: string; url: string };
  };
  expect(body.webhook).toBeTruthy();
  expect(body.row?.ref).toBeTruthy();
  expect(body.webhook!.url).toMatch(/\/_centraid-hook\//u);

  const sessionId = `edit-${appId}`;
  await openSession(sessionId);
  await putFile(
    appId,
    sessionId,
    `automations/${appId}/handler.js`,
    'export default async () => ({ summary: "fired" });\n'
  );
  await publish(appId, sessionId, "swap in a no-dispatch handler for the test");

  return {
    id: body.webhook!.id,
    secret: body.webhook!.secret,
    ref: body.row!.ref,
  };
}

describe("webhook-route-over-http scenarios", () => {
  beforeEach(async () => {
    dataDir = await tempDir(`gw-webhook-${crypto.randomUUID()}-`);
    handle = await serve({ paths: pathsUnder(dataDir) });
  });

  afterEach(async () => {
    await handle?.close().catch(() => undefined);
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  test("the correct secret durably ingresses then fires WITHOUT the gateway owner bearer token", async () => {
    const { id, secret, ref } = await createWebhookAutomation("hookapp");

    // Deliberately no `auth()` header — the gateway owner's bearer is
    // intentionally absent. The shared webhook secret is the only auth here.
    const res = await fetch(`${handle.url}/_centraid-hook/${id}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ hello: "world" }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      accepted: boolean;
      deliveryId?: string;
      error?: string;
    };
    expect(body.accepted).toBe(true);
    expect(body.deliveryId).toBeTruthy();
    expect(body.error).toBeUndefined();

    await vi.waitFor(async () => {
      const db = new DatabaseSync(await journalDbPath(), { readOnly: true });
      try {
        expect(
          (
            db.prepare("SELECT COUNT(*) AS n FROM trigger_ingress").get() as {
              n: number;
            }
          ).n
        ).toBe(1);
        const cursor = db
          .prepare(
            `SELECT position_json FROM automation_trigger_cursor
            WHERE automation_id = ? AND source_kind = 'webhook'`
          )
          .get(ref) as { position_json: string | null } | undefined;
        expect(cursor?.position_json).toStrictEqual(expect.any(String));
        expect(Number(JSON.parse(cursor!.position_json!))).toBeGreaterThan(0);
      } finally {
        db.close();
      }
    });

    await vi.waitFor(
      async () => {
        const db = new DatabaseSync(await journalDbPath(), { readOnly: true });
        try {
          const direct = db
            .prepare(
              `SELECT t.id AS turn_id, t.trigger_origin, t.ended_at, t.ok, c.automation_id
               FROM turns t JOIN conversations c ON c.id = t.conversation_id`
            )
            .all() as Array<{
            turn_id: string;
            trigger_origin: string;
            ended_at: number | null;
            ok: number | null;
            automation_id: string;
          }>;
          expect(direct).toContainEqual(
            expect.objectContaining({
              automation_id: ref,
              trigger_origin: "webhook",
              ended_at: expect.any(Number),
              ok: 1,
            })
          );
        } finally {
          db.close();
        }
        const feed = await fetch(
          `${handle.url}/centraid/_automations/turns?ref=${encodeURIComponent(ref)}`,
          { headers: auth() }
        );
        const payload = (await feed.json()) as {
          turns: Array<{
            triggerOrigin?: string;
            endedAt?: number;
            ok?: boolean;
          }>;
        };
        expect(payload.turns).toContainEqual(
          expect.objectContaining({
            triggerOrigin: "webhook",
            endedAt: expect.any(Number),
            ok: true,
          })
        );
      },
      { timeout: 10_000 }
    );
  });

  test("a wrong secret is rejected with 401, still without the gateway owner bearer token", async () => {
    const { id } = await createWebhookAutomation("hookapp2");

    const res = await fetch(`${handle.url}/_centraid-hook/${id}`, {
      method: "POST",
      headers: { Authorization: "Bearer not-the-right-secret" },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("secret");
  });

  test("an unknown webhook id is a 404", async () => {
    const res = await fetch(`${handle.url}/_centraid-hook/${"a".repeat(24)}`, {
      method: "POST",
      headers: { Authorization: "Bearer whatever-the-caller-sends" },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unknown webhook");
  });
});
