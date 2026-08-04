import crypto from "node:crypto";
/*
 * Bundled-app install over HTTP (issue #434). "Use template" cloned a
 * blueprint into the vault's git code store; install instead registers the
 * app + grants its declared scopes and serves it in place from the shipped
 * @centraid/blueprints package — no code copy, no git. This boots a real
 * git-store gateway and drives that exact wire path: install → listing union
 * → catalog install-state → per-vault rename → uninstall (grants revoked,
 * nothing in git) → reinstall (fresh consent). `tasks` is a real bundled app
 * (kind 'app', 15 declared scopes) so the grants are load-bearing.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, afterEach, beforeEach, expect, test } from "vitest";

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
  hasIndex?: boolean;
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
    handle = await serve({ paths: pathsUnder(dataDir) });
  });

  afterEach(async () => {
    await handle?.close().catch(() => undefined);
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  test("a fresh vault mounts with EVERY bundled app installed in place (#708)", async () => {
    // The catalogue is retired: nobody asks for a first-party app, so mount is
    // what puts it there. No install call runs anywhere in this test.
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

    // Metadata comes from the shipped blueprint dir (name + hasIndex prove the
    // resolver read the package, not an empty code store), and the app keeps
    // the blueprint's own id — no suggestCloneIdentityFrom minting.
    const row = (await listApps()).find((a) => a.id === "tasks");
    expect(row!.name).toBe("Tasks");
    expect(row!.kind).toBe("app");
    expect(row!.hasIndex).toBe(true);

    // Nothing was written to the git code store — no versions exist.
    const versions = await fetch(
      `${handle.url}/centraid/_apps/tasks/git-versions`,
      {
        headers: auth(),
      }
    );
    const vbody = (await versions.json()) as { versions: unknown[] };
    expect(vbody.versions).toHaveLength(0);

    // The declared scopes were granted at mount — being installed IS the
    // consent, and the Privacy ledger is where it is reviewed and revoked.
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

  test("a mounted vault can seed its bundled apps — the demo plane reaches the shipped tree", async () => {
    // Before #708 this was unreachable: the demo route scanned the git code
    // store, bundled apps serve in place, so a vault owning every seedable app
    // answered `{apps:[]}` and 404'd every seed request.
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

    // And it is all reversible in ONE act — which is what makes seeding a
    // personal vault an offer rather than something done to it.
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
    // Mount got there first — the route reports the existing registration
    // rather than minting a second one.
    expect(body.alreadyInstalled).toBe(true);

    // Still exactly one row in the listing (no duplicate).
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
    // Every APP-kind row reads installed on a mounted vault (#708). The flag
    // survives because it is still the gateway's own answer, and an audience
    // vault this member was added to but which has not mounted yet can still
    // say false — but on the vault you are looking at, it is always true.
    const appRows = rows.filter((t) => (t.kind ?? "app") !== "automation");
    expect(appRows.length).toBeGreaterThan(0);
    for (const row of appRows)
      expect(row.installed, `${row.id} install state`).toBe(true);

    // Uninstalling flips exactly that one row back, so the flag still MEANS
    // something rather than being a constant the route forgot to compute.
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

  test("the listing is a union — installed bundled app + code-store scaffold, no duplicates", async () => {
    await install("tasks");

    // Scaffold + publish a code-store app the old way.
    const create = await fetch(`${handle.url}/centraid/_apps`, {
      method: "POST",
      headers: jsonAuth(),
      body: JSON.stringify({
        id: "myscratch",
        name: "My Scratch",
        publish: true,
      }),
    });
    expect(create.status).toBe(201);

    const ids = (await listApps()).map((a) => a.id).sort();
    expect(ids).toContain("tasks"); // bundled, served in place
    expect(ids).toContain("myscratch"); // code-store
    // No id appears twice.
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("bundled ids are reserved — scaffold and clone of a bundled id are refused", async () => {
    const scaffold = await fetch(`${handle.url}/centraid/_apps`, {
      method: "POST",
      headers: jsonAuth(),
      body: JSON.stringify({ id: "tasks", name: "Impostor", publish: true }),
    });
    expect(scaffold.status).toBe(409);

    const clone = await fetch(`${handle.url}/centraid/_apps/_clone`, {
      method: "POST",
      headers: jsonAuth(),
      body: JSON.stringify({ templateId: "tasks", publish: true }),
    });
    // Clone of a bundled app is rejected (install it instead).
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

    // Clearing (blank) falls back to the manifest name.
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

    // Uninstall — DELETE tolerates "nothing in git" and runs the revoke cascade.
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

    // Gone from the listing and no longer an active enrollment.
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

    // Reinstall — fresh consent: the declared scopes are granted again (the
    // revoke cascade cleared the tombstones).
    const re = await install("tasks");
    expect(re.status).toBe(200);
    const grantsAfter = (await vaultApps())
      .find((a) => a.name === "tasks")!
      .grants.reduce((n, g) => n + g.scopes.length, 0);
    expect(grantsAfter).toBe(grantsBefore);
  });
});
