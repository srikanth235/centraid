import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, afterEach, beforeEach, expect, test } from "vitest";

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

function jsonAuth(): Record<string, string> {
  return { ...auth(), "Content-Type": "application/json" };
}

interface AppRow {
  id: string;
  name?: string;
  description?: string;
  kind?: string;
  iconKey?: string;
  colorKey?: string;
}

async function listApps(): Promise<AppRow[]> {
  const res = await fetch(`${handle.url}/centraid/_apps`, { headers: auth() });
  return (await res.json()) as AppRow[];
}

interface VaultAppRow {
  name: string;
  status: string;
  origin: string;
  grants: { scopes: { schema: string; table?: string; verbs: string }[] }[];
}

async function vaultApps(): Promise<VaultAppRow[]> {
  const res = await fetch(`${handle.url}/centraid/_vault/apps`, {
    headers: auth(),
  });
  const body = (await res.json()) as { apps: VaultAppRow[] };
  return body.apps;
}

async function install(templateId: string): Promise<Response> {
  return fetch(`${handle.url}/centraid/_apps/_install`, {
    method: "POST",
    headers: jsonAuth(),
    body: JSON.stringify({ templateId }),
  });
}

describe("install-over-http scenarios", () => {
  beforeEach(async () => {
    dataDir = await tempDir(`gw-install-${crypto.randomUUID()}-`);
    handle = await serve({
      paths: pathsUnder(dataDir),
      experimental: { automations: true },
    });
  });

  afterEach(async () => {
    await handle?.close().catch(() => undefined);
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  test("a fresh vault mounts with EVERY bundled app installed in place (#708)", async () => {
    const ids = new Set((await listApps()).map((a) => a.id));
    for (const id of [
      "agenda",
      "docs",
      "locker",
      "notes",
      "people",
      "photos",
      "tally",
      "tasks",
    ])
      expect(ids, `${id} installed at mount`).toContain(id);

    const row = (await listApps()).find((a) => a.id === "tasks");
    expect(row!.name).toBe("Tasks");
    expect(row!.kind).toBe("app");

    const versions = await fetch(
      `${handle.url}/centraid/_apps/tasks/git-versions`,
      {
        headers: auth(),
      }
    );
    const vbody = (await versions.json()) as { versions: unknown[] };
    expect(vbody.versions).toHaveLength(0);

    const enrolled = (await vaultApps()).find((a) => a.name === "tasks");
    expect(enrolled).toBeTruthy();
    expect(enrolled!.origin).toBe("installed");
    expect(enrolled!.status).toBe("active");
    const scopeCount = enrolled!.grants.reduce(
      (n, g) => n + g.scopes.length,
      0
    );
    expect(scopeCount).toBeGreaterThan(0);
  });

  test("capture OCR enters the installed recipe and records service absence as a failed turn", async () => {
    const ref = "photo-ocr/photo-ocr";
    const enabled = await fetch(
      `${handle.url}/centraid/_automations/set-enabled?ref=${encodeURIComponent(ref)}`,
      {
        method: "POST",
        headers: jsonAuth(),
        body: JSON.stringify({ enabled: true, publish: true }),
      }
    );
    expect(enabled.status).toBe(200);

    const capture = await fetch(`${handle.url}/centraid/_gateway/capture/ocr`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "image/jpeg" },
      body: Buffer.from("not-a-real-image-the-service-is-absent"),
    });
    expect(capture.status).toBe(503);

    const history = await fetch(
      `${handle.url}/centraid/_automations/turns?ref=${encodeURIComponent(ref)}&limit=5`,
      { headers: auth() }
    );
    expect(history.status).toBe(200);
    const body = (await history.json()) as {
      turns: Array<{ ok: boolean | null; error?: string }>;
    };
    expect(body.turns[0]).toMatchObject({ ok: false });
    expect(body.turns[0]?.error).toContain("capture OCR unavailable");
  });

  test("mount manages stable recognition recipes without overwriting owner controls", async () => {
    const response = await fetch(`${handle.url}/centraid/_automations`, {
      headers: auth(),
    });
    expect(response.status).toBe(200);
    const { rows } = (await response.json()) as {
      rows: Array<{
        ref: string;
        enabled: boolean;
        systemLane?: string;
      }>;
    };
    for (const ref of [
      "photo-ocr/photo-ocr",
      "transcript/transcript",
      "embed-image/embed-image",
      "embed-text/embed-text",
      "faces/faces",
    ]) {
      expect(rows.find((row) => row.ref === ref)).toMatchObject({
        enabled: false,
        systemLane: "recognition",
      });
    }

    const versions = await fetch(
      `${handle.url}/centraid/_apps/photo-ocr/git-versions`,
      { headers: auth() }
    );
    expect(versions.status).toBe(200);
    const body = (await versions.json()) as { versions: unknown[] };
    expect(body.versions).toHaveLength(1);

    await forEachSequentially(
      [
        {
          path: "/centraid/_automations/compile?ref=photo-ocr%2Fphoto-ocr",
          method: "POST",
          body: {},
        },
        {
          path: "/centraid/_automations/revise?ref=photo-ocr%2Fphoto-ocr",
          method: "POST",
          body: { message: "replace the shipped implementation" },
        },
        {
          path: "/centraid/_automations/update?ref=photo-ocr%2Fphoto-ocr",
          method: "POST",
          body: { prompt: "replace the shipped instructions", publish: true },
        },
        {
          path: "/centraid/_automations?ref=photo-ocr%2Fphoto-ocr&publish=true",
          method: "DELETE",
        },
        {
          path: "/centraid/_apps/photo-ocr",
          method: "DELETE",
        },
        {
          path: "/centraid/_apps/photo-ocr/meta",
          method: "POST",
          body: { name: "Shadow OCR", publish: true },
        },
      ],
      async (mutation) => {
        const blocked = await fetch(`${handle.url}${mutation.path}`, {
          method: mutation.method,
          headers: jsonAuth(),
          ...(mutation.body === undefined
            ? {}
            : { body: JSON.stringify(mutation.body) }),
        });
        expect(blocked.status, mutation.path).toBe(403);
        await expect(blocked.json()).resolves.toMatchObject({
          error: "system_recipe_read_only",
        });
      }
    );

    const enabled = await fetch(
      `${handle.url}/centraid/_automations/set-enabled?ref=photo-ocr%2Fphoto-ocr`,
      {
        method: "POST",
        headers: jsonAuth(),
        body: JSON.stringify({ enabled: true, publish: true }),
      }
    );
    expect(enabled.status).toBe(200);
    const configured = await fetch(
      `${handle.url}/centraid/_automations/update?ref=photo-ocr%2Fphoto-ocr`,
      {
        method: "POST",
        headers: jsonAuth(),
        body: JSON.stringify({
          model: "openai/gpt-4o-mini",
          recognitionStep: "delegate",
          publish: true,
        }),
      }
    );
    expect(configured.status).toBe(200);
    const configuredVersions = (await (
      await fetch(`${handle.url}/centraid/_apps/photo-ocr/git-versions`, {
        headers: auth(),
      })
    ).json()) as { versions: unknown[] };

    await handle.close();
    handle = await serve({
      paths: pathsUnder(dataDir),
      experimental: { automations: true },
    });
    const afterRestart = await fetch(
      `${handle.url}/centraid/_apps/photo-ocr/git-versions`,
      { headers: auth() }
    );
    const restartedBody = (await afterRestart.json()) as {
      versions: unknown[];
    };
    expect(restartedBody.versions).toHaveLength(
      configuredVersions.versions.length
    );
    const restartedRows = (await (
      await fetch(`${handle.url}/centraid/_automations`, { headers: auth() })
    ).json()) as {
      rows: Array<{
        ref: string;
        enabled: boolean;
        manifest: {
          requires: { model?: string };
          enrich?: { delegateStep?: { selected?: string } };
        };
      }>;
    };
    expect(
      restartedRows.rows.find((row) => row.ref === "photo-ocr/photo-ocr")
    ).toMatchObject({
      enabled: true,
      manifest: {
        requires: { model: "openai/gpt-4o-mini" },
        enrich: { delegateStep: { selected: "delegate" } },
      },
    });
  });

  test("a mounted vault can seed its bundled apps — the demo plane reaches the shipped tree", async () => {
    const listed = (await (
      await fetch(`${handle.url}/centraid/_vault/demo`, { headers: auth() })
    ).json()) as { apps: { appId: string; rows: number; seedable: boolean }[] };
    const seedable = listed.apps.filter((a) => a.seedable).map((a) => a.appId);
    expect(seedable).toContain("tasks");
    for (const app of seedable)
      expect(listed.apps.find((a) => a.appId === app)?.rows).toBe(0);

    const seeded = await fetch(`${handle.url}/centraid/_vault/demo/tasks`, {
      method: "POST",
      headers: jsonAuth(),
    });
    expect(seeded.status).toBe(200);
    const body = (await seeded.json()) as { ok: boolean; rows: number };
    expect(body.ok).toBe(true);
    expect(body.rows).toBeGreaterThan(0);

    const purged = await fetch(`${handle.url}/centraid/_vault/demo`, {
      method: "DELETE",
      headers: auth(),
    });
    expect(purged.status).toBe(200);
    const after = (await (
      await fetch(`${handle.url}/centraid/_vault/demo`, { headers: auth() })
    ).json()) as { apps: { appId: string; rows: number }[] };
    expect(after.apps.find((a) => a.appId === "tasks")?.rows).toBe(0);
  }, 120_000);

  test("install is idempotent — installing what mount already installed is a no-op", async () => {
    const res = await install("tasks");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      app: { id: string; name?: string };
      installed: boolean;
      alreadyInstalled: boolean;
    };
    expect(body.app.id).toBe("tasks");
    expect(body.app.name).toBe("Tasks");
    expect(body.installed).toBe(true);
    expect(body.alreadyInstalled).toBe(true);

    const rows = (await listApps()).filter((a) => a.id === "tasks");
    expect(rows).toHaveLength(1);
  });

  test("unknown template id → 404", async () => {
    const res = await install("does-not-exist");
    expect(res.status).toBe(404);
  });

  test("the catalog reports per-vault install state — true for every bundled app", async () => {
    const res = await fetch(`${handle.url}/centraid/_templates`, {
      headers: auth(),
    });
    const rows = (await res.json()) as {
      id: string;
      kind?: string;
      installed?: boolean;
    }[];
    const appRows = rows.filter((t) => (t.kind ?? "app") !== "automation");
    expect(appRows.length).toBeGreaterThan(0);
    for (const row of appRows)
      expect(row.installed, `${row.id} install state`).toBe(true);

    const del = await fetch(`${handle.url}/centraid/_apps/tasks`, {
      method: "DELETE",
      headers: auth(),
    });
    expect(del.status).toBe(200);
    const after = (await (
      await fetch(`${handle.url}/centraid/_templates`, { headers: auth() })
    ).json()) as { id: string; installed?: boolean }[];
    expect(after.find((t) => t.id === "tasks")?.installed).toBe(false);
    expect(after.find((t) => t.id === "notes")?.installed).toBe(true);
  });

  test("the listing is a union — installed bundled app + code-store app, no duplicates", async () => {
    await install("tasks");

    const create = await fetch(`${handle.url}/centraid/_automations`, {
      method: "POST",
      headers: jsonAuth(),
      body: JSON.stringify({
        id: "myscratch",
        name: "My Scratch",
        prompt: "summarize the day",
        triggers: [{ kind: "cron", expr: "0 9 * * *" }],
        publish: true,
      }),
    });
    expect(create.status).toBe(201);

    const ids = (await listApps()).map((a) => a.id).sort();
    expect(ids).toContain("tasks"); // bundled, served in place
    expect(ids).toContain("myscratch"); // code-store
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("bundled ids are reserved — a code-store create and clone of a bundled id are refused", async () => {
    const scaffold = await fetch(`${handle.url}/centraid/_automations`, {
      method: "POST",
      headers: jsonAuth(),
      body: JSON.stringify({
        id: "tasks",
        name: "Impostor",
        prompt: "impersonate",
        triggers: [{ kind: "cron", expr: "0 9 * * *" }],
        publish: true,
      }),
    });
    expect(scaffold.status).toBe(409);

    const clone = await fetch(`${handle.url}/centraid/_apps/_clone`, {
      method: "POST",
      headers: jsonAuth(),
      body: JSON.stringify({ templateId: "tasks", publish: true }),
    });
    expect(clone.status).toBe(409);
  });

  test("per-vault rename via /meta sets a label honored by the listing; blank clears it", async () => {
    await install("tasks");

    const rename = await fetch(`${handle.url}/centraid/_apps/tasks/meta`, {
      method: "POST",
      headers: jsonAuth(),
      body: JSON.stringify({ name: "My To-Dos", publish: true }),
    });
    expect(rename.status).toBe(200);
    let row = (await listApps()).find((a) => a.id === "tasks");
    expect(row!.name).toBe("My To-Dos");

    const clear = await fetch(`${handle.url}/centraid/_apps/tasks/meta`, {
      method: "POST",
      headers: jsonAuth(),
      body: JSON.stringify({ name: "", publish: true }),
    });
    expect(clear.status).toBe(200);
    row = (await listApps()).find((a) => a.id === "tasks");
    expect(row!.name).toBe("Tasks");
  });

  test("uninstall revokes grants + drops from the listing, keeps nothing in git; reinstall is fresh consent", async () => {
    await install("tasks");
    const grantsBefore = (await vaultApps())
      .find((a) => a.name === "tasks")!
      .grants.reduce((n, g) => n + g.scopes.length, 0);
    expect(grantsBefore).toBeGreaterThan(0);

    const del = await fetch(`${handle.url}/centraid/_apps/tasks`, {
      method: "DELETE",
      headers: auth(),
    });
    expect(del.status).toBe(200);
    const delBody = (await del.json()) as {
      deleted: boolean;
      codeRemoved: boolean;
    };
    expect(delBody.deleted).toBe(true);
    expect(delBody.codeRemoved).toBe(false); // there was never any code in git

    expect((await listApps()).some((a) => a.id === "tasks")).toBe(false);
    expect((await vaultApps()).some((a) => a.name === "tasks")).toBe(false);
    const afterCat = await fetch(`${handle.url}/centraid/_templates`, {
      headers: auth(),
    });
    const catRows = (await afterCat.json()) as {
      id: string;
      installed?: boolean;
    }[];
    expect(catRows.find((t) => t.id === "tasks")?.installed).toBe(false);

    const re = await install("tasks");
    expect(re.status).toBe(200);
    const grantsAfter = (await vaultApps())
      .find((a) => a.name === "tasks")!
      .grants.reduce((n, g) => n + g.scopes.length, 0);
    expect(grantsAfter).toBe(grantsBefore);
  });
});
