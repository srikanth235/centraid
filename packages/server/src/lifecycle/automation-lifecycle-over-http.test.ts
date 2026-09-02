import crypto from "node:crypto";
// governance: allow-repo-hygiene file-size-limit (#608) cohesive automation lifecycle suite shares one production HTTP and scheduler fixture
import { promises as fs } from "node:fs";
/*
 * Automation CRUD over HTTP (#141). The desktop does not
 * mutate an automation in a local worktree — it reads the app's draft
 * over HTTP, applies the file-map transform (toggle / delete), writes the
 * changed/removed files back through the git-store session routes, and
 * publishes. The gateway reconciles the OS scheduler on publish, so the
 * desktop registers nothing itself. This boots a real gateway and drives
 * two of those wire paths end to end:
 *   1. toggle an app-owned automation's `enabled` flag and republish, and
 *   2. delete an app-owned automation's subdir (file DELETE + republish)
 *      while the owning UI app survives.
 */
import path from "node:path";

import { describe, afterEach, beforeEach, expect, test } from "vitest";

import type { ScaffoldFile } from "@centraid/blueprints";
import * as automation from "@centraid/server/automation";
import { forEachSequentially } from "@centraid/test-kit/sequential";
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

function auth(): Record<string, string> {
  return { Authorization: `Bearer ${handle.token}` };
}

// A UI app (kind defaults to 'app') that owns one automation under
// `automations/digest/`. The app.json mirrors what a published app carries;
// the automation manifest is appended manually.
function uiAppWithAutomation(enabled: boolean): ScaffoldFile[] {
  return [
    {
      path: "package.json",
      content:
        JSON.stringify(
          {
            name: "centraid-app-notes",
            version: "0.1.0",
            private: true,
            type: "module",
          },
          null,
          2
        ) + "\n",
    },
    {
      path: "app.json",
      content:
        JSON.stringify(
          {
            manifestVersion: 1,
            id: "notes",
            name: "Notes",
            version: "0.1.0",
            iconKey: "Sparkle",
            colorKey: "violet",
            actions: [],
            queries: [],
          },
          null,
          2
        ) + "\n",
    },
    {
      path: "automations/digest/automation.json",
      content:
        JSON.stringify(
          {
            name: "Digest",
            version: "0.1.0",
            enabled,
            prompt: "summarize notes",
            triggers: [{ kind: "cron", expr: "0 9 * * *" }],
            requires: {},
            history: { keep: { count: 100 } },
            generated: { by: "tmpl", at: "2020-01-01T00:00:00.000Z" },
          },
          null,
          2
        ) + "\n",
    },
    {
      path: "automations/digest/handler.js",
      content: 'export default async () => ({ summary: "ok" });\n',
    },
  ];
}

async function openSession(sessionId: string): Promise<void> {
  await fetch(`${handle.url}/centraid/_apps/_sessions`, {
    method: "POST",
    headers: { ...auth(), "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
}

async function putFiles(
  appId: string,
  sessionId: string,
  files: ScaffoldFile[]
): Promise<void> {
  await forEachSequentially(files, async (f) => {
    const res = await fetch(
      `${handle.url}/centraid/_apps/${appId}/files/${f.path
        .split("/")
        .map(encodeURIComponent)
        .join("/")}?sessionId=${sessionId}`,
      { method: "PUT", headers: auth(), body: f.content }
    );
    expect(res.status).toBe(200);
  });
}

async function publish(
  appId: string,
  sessionId: string,
  message: string
): Promise<void> {
  const res = await fetch(`${handle.url}/centraid/_apps/${appId}/publish`, {
    method: "POST",
    headers: { ...auth(), "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, message }),
  });
  expect(res.status).toBe(201);
}

async function readDraft(
  appId: string,
  sessionId: string
): Promise<ScaffoldFile[]> {
  const res = await fetch(
    `${handle.url}/centraid/_apps/${appId}/files?sessionId=${sessionId}`,
    {
      headers: auth(),
    }
  );
  const out = (await res.json()) as { files: ScaffoldFile[] };
  return out.files ?? [];
}

describe("automation-lifecycle-over-http scenarios", () => {
  beforeEach(async () => {
    dataDir = await tempDir(`gw-autocrud-${crypto.randomUUID()}-`);
    handle = await serve({
      paths: pathsUnder(dataDir),
      experimental: { automations: true },
    });
  }, 30_000);

  afterEach(async () => {
    await handle?.close().catch(() => undefined);
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  test("toggling an app-owned automation enabled flag over HTTP republishes the manifest", async () => {
    await openSession("s1");
    await putFiles("notes", "s1", uiAppWithAutomation(false));
    await publish("notes", "s1", "scaffold");

    // Toggle enabled false → true, exactly as AUTOMATIONS_SET_ENABLED does.
    const current = await readDraft("notes", "s1");
    const changed = automation.setEnabledInFiles(current, "digest", true);
    expect(changed).toHaveLength(1);
    await putFiles("notes", "s1", changed);
    await publish("notes", "s1", "toggle digest");

    const after = await readDraft("notes", "s1");
    const manifest = JSON.parse(
      after.find((f) => f.path === "automations/digest/automation.json")!
        .content
    ) as { enabled: boolean };
    expect(manifest.enabled).toBe(true);
  });

  // Which trigger shapes are legal is the manifest validator's law, owned by
  // `packages/server/src/automation/manifest/manifest.test.ts`. The tests below prove
  // only what the route itself does: the kind pre-check, the cron default, the
  // hand-written wire→manifest mapping, and that a validator rejection comes
  // back out as a 400 `bad_request` carrying the validator's own message. They
  // deliberately do NOT re-enumerate malformed-trigger cases.

  test("create defaults an expr-only trigger entry to cron", async () => {
    const ok = await fetch(`${handle.url}/centraid/_automations`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "minutely",
        triggers: [{ expr: "* * * * *" }],
        publish: true,
      }),
    });
    expect(ok.status).toBe(201);
    const out = (await ok.json()) as {
      row: { manifest: { triggers: unknown[] } } | null;
    };
    expect(out.row?.manifest.triggers).toStrictEqual([
      { kind: "cron", expr: "* * * * *" },
    ]);
  });

  test("create maps well-formed data and condition trigger bodies into the published manifest verbatim", async () => {
    const res = await fetch(`${handle.url}/centraid/_automations`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "watcher-vault",
        triggers: [
          {
            kind: "data",
            entities: ["core.content_derivative"],
            every: "*/5 * * * *",
          },
          {
            kind: "condition",
            entity: "core.invoice",
            where: [{ column: "due_at", op: "within-days", value: 3 }],
          },
        ],
        vault: {
          purpose: "dpv:ServiceProvision",
          scopes: [
            { schema: "core", table: "content_derivative", verbs: "read" },
            { schema: "core", table: "invoice", verbs: "read" },
          ],
        },
        publish: true,
      }),
    });
    expect(res.status).toBe(201);
    const out = (await res.json()) as {
      row: { manifest: { triggers: unknown[] } } | null;
    };
    expect(out.row?.manifest.triggers).toStrictEqual([
      {
        kind: "data",
        entities: ["core.content_derivative"],
        every: "*/5 * * * *",
      },
      {
        kind: "condition",
        entity: "core.invoice",
        where: [{ column: "due_at", op: "within-days", value: 3 }],
      },
    ]);
  });

  test("create surfaces the manifest validator's field-scoped rejection as a 400", async () => {
    const res = await fetch(`${handle.url}/centraid/_automations`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "watcher-bad-condition",
        triggers: [
          { kind: "condition", entity: "core.invoice", where: "not-an-array" },
        ],
        vault: {
          purpose: "dpv:ServiceProvision",
          scopes: [{ schema: "core", table: "invoice", verbs: "read" }],
        },
      }),
    });
    expect(res.status).toBe(400);
    const out = (await res.json()) as { error: string; message: string };
    expect(out.error).toBe("bad_request");
    // Verbatim validator text, not a route-authored paraphrase.
    expect(out.message).toContain(
      "where must be an array of {column, op, value?} clauses"
    );
  });

  test("create rejects an unsupported trigger kind before it reaches the scaffolder", async () => {
    const res = await fetch(`${handle.url}/centraid/_automations`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "watcher-unknown-kind",
        triggers: [{ kind: "carrier-pigeon" }],
      }),
    });
    expect(res.status).toBe(400);
    const out = (await res.json()) as { error: string; message: string };
    expect(out.error).toBe("bad_request");
    expect(out.message).toContain("carrier-pigeon");
    // The app must not exist — the guard fires before any scaffold/publish.
    const listRes = await fetch(`${handle.url}/centraid/_apps`, {
      headers: auth(),
    });
    const list = (await listRes.json()) as Array<{ id: string }>;
    expect(list.some((a) => a.id === "watcher-unknown-kind")).toBe(false);
  });

  test("rotating a webhook secret mints a fresh secret over the SAME route id", async () => {
    const create = await fetch(`${handle.url}/centraid/_automations`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "rotator",
        name: "rotator",
        prompt: "fire on inbound webhook",
        triggers: [{ kind: "webhook" }],
        publish: true,
      }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as {
      webhook?: { id: string; secret: string; url: string };
    };
    expect(created.webhook).toBeTruthy();
    const originalId = created.webhook!.id;
    const originalSecret = created.webhook!.secret;

    const rotate = await fetch(
      `${handle.url}/centraid/_automations/rotate-webhook?ref=${encodeURIComponent("rotator/rotator")}`,
      {
        method: "POST",
        headers: { ...auth(), "Content-Type": "application/json" },
        body: JSON.stringify({ publish: true }),
      }
    );
    expect(rotate.status).toBe(200);
    const rotated = (await rotate.json()) as {
      ok: boolean;
      webhook: { id: string; secret: string; url: string };
    };
    expect(rotated.ok).toBe(true);
    // Same route id — any already-configured caller URL keeps working.
    expect(rotated.webhook.id).toBe(originalId);
    expect(rotated.webhook.secret).not.toBe(originalSecret);
    expect(rotated.webhook.url).toMatch(/\/_centraid-hook\//u);

    // The old secret no longer verifies; the wire-level webhook route reflects
    // the rotation (auth is the hash on `main`, which the publish landed).
    const oldRes = await fetch(`${handle.url}/_centraid-hook/${originalId}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${originalSecret}` },
    });
    expect(oldRes.status).toBe(401);
  });

  test("rotating a webhook secret on an unknown ref is a 404", async () => {
    const res = await fetch(
      `${handle.url}/centraid/_automations/rotate-webhook?ref=${encodeURIComponent("nope/nope")}`,
      {
        method: "POST",
        headers: { ...auth(), "Content-Type": "application/json" },
      }
    );
    expect(res.status).toBe(404);
    const out = (await res.json()) as { error: string };
    expect(out.error).toBe("not_found");
  });

  test("rotating a non-webhook automation is a 400", async () => {
    await openSession("s3");
    await putFiles("notes", "s3", uiAppWithAutomation(true));
    await publish("notes", "s3", "scaffold");

    const res = await fetch(
      `${handle.url}/centraid/_automations/rotate-webhook?ref=${encodeURIComponent("notes/digest")}`,
      {
        method: "POST",
        headers: { ...auth(), "Content-Type": "application/json" },
        body: JSON.stringify({ publish: true }),
      }
    );
    expect(res.status).toBe(400);
    const out = (await res.json()) as { error: string; message: string };
    expect(out.error).toBe("bad_request");
    expect(out.message).toContain("webhook");
  });

  test("publishing a draft edit with a malformed automation.json 400s instead of landing on main", async () => {
    // Exactly how the builder's trigger editor applies changes: a scaffolded
    // standalone automation app (`app.json#kind === 'automation'`, the shape
    // POST /centraid/_automations produces) publishes fine, then a follow-up
    // edit rewrites automation.json through the generic draft file-write route
    // (not the dedicated create route, which validates trigger/vault shapes on
    // the way in). `validateManifestAt` must parse `automation.json` itself, or
    // a malformed edit rides through publish and only fails at fire/schedule time.
    await openSession("s4");
    await putFiles(
      "digest-app",
      "s4",
      automation.scaffoldAppFiles("digest-app", {
        name: "Digest",
        prompt: "summarize notes",
        triggers: [{ kind: "cron", expr: "0 9 * * *" }],
      })
    );
    await publish("digest-app", "s4", "scaffold");

    const badManifest = {
      name: "Digest",
      version: "0.1.0",
      enabled: true,
      prompt: "summarize notes",
      // A data trigger's `entities` must be an array of <schema>.<table>
      // names — this is a string, which the manifest schema rejects.
      triggers: [{ kind: "data", entities: "core.content_derivative" }],
      requires: {},
      history: { keep: { count: 100 } },
      generated: { by: "tmpl", at: "2020-01-01T00:00:00.000Z" },
    };
    const putRes = await fetch(
      `${handle.url}/centraid/_apps/digest-app/files/automations/digest-app/automation.json?sessionId=s4`,
      {
        method: "PUT",
        headers: auth(),
        body: JSON.stringify(badManifest, null, 2),
      }
    );
    expect(putRes.status).toBe(200);

    const publishRes = await fetch(
      `${handle.url}/centraid/_apps/digest-app/publish`,
      {
        method: "POST",
        headers: { ...auth(), "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "s4", message: "break the trigger" }),
      }
    );
    expect(publishRes.status).toBe(400);
    const out = (await publishRes.json()) as { error: string; message: string };
    expect(out.error).toBe("invalid_manifest");
    expect(out.message).toMatch(/automations\/digest-app\/automation\.json/u);
    expect(out.message).toMatch(/entities/u);

    // main is untouched — a FRESH session (forked off current main) still
    // reads the original cron trigger, not the rejected draft edit.
    await openSession("s4-check");
    const live = await readDraft("digest-app", "s4-check");
    const liveManifest = JSON.parse(
      live.find((f) => f.path === "automations/digest-app/automation.json")!
        .content
    ) as { triggers: unknown[] };
    expect(liveManifest.triggers).toStrictEqual([
      { kind: "cron", expr: "0 9 * * *" },
    ]);
  });

  test("publishing a well-formed automation.json edit through the draft route still succeeds", async () => {
    await openSession("s5");
    await putFiles(
      "digest-app2",
      "s5",
      automation.scaffoldAppFiles("digest-app2", {
        name: "Digest",
        prompt: "summarize notes",
        triggers: [{ kind: "cron", expr: "0 9 * * *" }],
      })
    );
    await publish("digest-app2", "s5", "scaffold");

    const goodManifest = {
      name: "Digest",
      version: "0.1.0",
      enabled: true,
      prompt: "summarize notes, now hourly",
      triggers: [{ kind: "cron", expr: "0 * * * *" }],
      requires: {},
      history: { keep: { count: 100 } },
      generated: { by: "tmpl", at: "2020-01-01T00:00:00.000Z" },
    };
    const putRes = await fetch(
      `${handle.url}/centraid/_apps/digest-app2/files/automations/digest-app2/automation.json?sessionId=s5`,
      {
        method: "PUT",
        headers: auth(),
        body: JSON.stringify(goodManifest, null, 2),
      }
    );
    expect(putRes.status).toBe(200);
    await publish("digest-app2", "s5", "reschedule digest hourly");

    const after = await readDraft("digest-app2", "s5");
    const manifest = JSON.parse(
      after.find((f) => f.path === "automations/digest-app2/automation.json")!
        .content
    ) as { triggers: unknown[] };
    expect(manifest.triggers).toStrictEqual([
      { kind: "cron", expr: "0 * * * *" },
    ]);
  });

  test("deleting an app-owned automation over HTTP removes the subdir but keeps the app", async () => {
    await openSession("s2");
    await putFiles("notes", "s2", uiAppWithAutomation(true));
    await publish("notes", "s2", "scaffold");

    // Delete the automation subdir, exactly as AUTOMATIONS_DELETE's app-owned
    // branch does: file-map transform → DELETE each removed path → republish.
    const current = await readDraft("notes", "s2");
    const { removed } = automation.deleteFromFiles(current, "digest");
    expect(removed.sort()).toStrictEqual([
      "automations/digest/automation.json",
      "automations/digest/handler.js",
    ]);
    await forEachSequentially(removed, async (rel) => {
      const res = await fetch(
        `${handle.url}/centraid/_apps/notes/files/${rel
          .split("/")
          .map(encodeURIComponent)
          .join("/")}?sessionId=s2`,
        { method: "DELETE", headers: auth() }
      );
      expect(res.status).toBe(200);
    });
    await publish("notes", "s2", "delete digest");

    // The app survives on `main`; the automation's files are gone.
    const listRes = await fetch(`${handle.url}/centraid/_apps`, {
      headers: auth(),
    });
    const list = (await listRes.json()) as Array<{ id: string }>;
    expect(list.some((a) => a.id === "notes")).toBeTruthy();
    const after = await readDraft("notes", "s2");
    expect(after.some((f) => f.path === "app.json")).toBeTruthy();
    expect(
      !after.some((f) => f.path.startsWith("automations/digest/"))
    ).toBeTruthy();
  });
});
