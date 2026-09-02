import { promises as fs } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";

import type { VaultRegistry } from "../serve/vault-registry.js";
import { makeDemoRouteHandler } from "./demo-routes.js";

const mocks = vi.hoisted(() => ({
  runHandler: vi.fn<typeof import("@centraid/server/engine").runHandler>(),
}));

vi.mock(import("@centraid/server/engine"), () => ({
  runHandler: mocks.runHandler,
}));

const servers: http.Server[] = [];

describe("demo routes", () => {
  afterEach(() => {
    mocks.runHandler.mockReset();
    for (const server of servers.splice(0)) server.close();
  });

  test("lists seedable/status apps and handles purge, missing, and method boundaries", async () => {
    const codeAppsDir = await tempDir("demo-routes-");
    await writeSeed(codeAppsDir, "alpha");
    await writeSeed(codeAppsDir, "seed-only");
    const purgeDemo = vi.fn<(appId?: string) => { purged: number }>(
      (appId?: string) => ({
        purged: appId === undefined ? 7 : 3,
      })
    );
    const handler = makeDemoRouteHandler(
      fakeVaults({
        demoStatus: () => [
          { appId: "alpha", rows: 3 },
          { appId: "rows-only", rows: 4 },
        ],
        purgeDemo,
      }),
      { bundledAppDirs: () => new Map(), codeAppsDir: () => codeAppsDir }
    );
    const base = await serve(handler);

    const listed = await fetch(`${base}/centraid/_vault/demo`);
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toStrictEqual({
      apps: [
        { appId: "alpha", rows: 3, seedable: true },
        { appId: "rows-only", rows: 4, seedable: false },
        { appId: "seed-only", rows: 0, seedable: true },
      ],
    });

    const missing = await fetch(`${base}/centraid/_vault/demo/missing`, {
      method: "POST",
    });
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toStrictEqual({
      error: 'app "missing" ships no seed.js scenario',
    });

    const one = await fetch(`${base}/centraid/_vault/demo/alpha`, {
      method: "DELETE",
    });
    expect(one.status).toBe(200);
    await expect(one.json()).resolves.toStrictEqual({ purged: 3 });
    expect(purgeDemo).toHaveBeenNthCalledWith(1, "alpha");

    const all = await fetch(`${base}/centraid/_vault/demo`, {
      method: "DELETE",
    });
    expect(all.status).toBe(200);
    await expect(all.json()).resolves.toStrictEqual({ purged: 7 });
    expect(purgeDemo).toHaveBeenNthCalledWith(2, undefined);

    const unsupported = await fetch(`${base}/centraid/_vault/demo`, {
      method: "PATCH",
    });
    expect(unsupported.status).toBe(405);
    await expect(unsupported.json()).resolves.toStrictEqual({
      error: "unsupported PATCH on /centraid/_vault/demo",
    });

    const unmatched = await fetch(`${base}/other`);
    expect(unmatched.status).toBe(204);
    await expect(unmatched.text()).resolves.toBe("");
  });

  test("runs a deterministic seed and reports worker failures honestly", async () => {
    const codeAppsDir = await tempDir("demo-routes-run-");
    await writeSeed(codeAppsDir, "alpha");
    const bridge = { invoke: vi.fn<() => void>() };
    const handler = makeDemoRouteHandler(
      fakeVaults({
        demoStatus: () => [{ appId: "alpha", rows: 9 }],
        demoBridgeFor: () => bridge,
      }),
      { bundledAppDirs: () => new Map(), codeAppsDir: () => codeAppsDir }
    );
    const base = await serve(handler);

    mocks.runHandler.mockResolvedValueOnce({
      ok: true,
      value: { seeded: 9 },
      logs: [],
    });
    const loaded = await fetch(`${base}/centraid/_vault/demo/alpha`, {
      method: "POST",
    });
    expect(loaded.status).toBe(200);
    await expect(loaded.json()).resolves.toStrictEqual({
      ok: true,
      result: { seeded: 9 },
      rows: 9,
    });
    expect(mocks.runHandler).toHaveBeenCalledOnce();
    const call = mocks.runHandler.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      app: { id: "alpha" },
      args: { input: { seed: 1 } },
      handlerFile: path.join(codeAppsDir, "alpha", "seed.js"),
      handlerKind: "action",
      timeoutMs: 60_000,
      vault: bridge,
    });
    const args = call?.args as
      | { input: { seed: number; now: string } }
      | undefined;
    expect(args?.input.now).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u
    );
    expect(call?.timeModuleUrl).toMatch(
      /\/packages\/core\/dist\/time\/index\.js$/u
    );

    mocks.runHandler.mockResolvedValueOnce({
      ok: false,
      error: "seed exploded",
      logs: [{ level: "error", msg: "safe diagnostic" }],
    });
    const failed = await fetch(`${base}/centraid/_vault/demo/alpha`, {
      method: "POST",
    });
    expect(failed.status).toBe(500);
    await expect(failed.json()).resolves.toStrictEqual({
      error: "seed exploded",
      logs: [{ level: "error", msg: "safe diagnostic" }],
    });
  });

  test("an unreadable code-app directory behaves as an empty gallery", async () => {
    const handler = makeDemoRouteHandler(fakeVaults(), {
      bundledAppDirs: () => new Map(),
      codeAppsDir: () => "/definitely/missing/demo-apps",
    });
    const base = await serve(handler);
    const listed = await fetch(`${base}/centraid/_vault/demo`);
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toStrictEqual({ apps: [] });
  });

  test("finds a BUNDLED app's generator, which lives outside the code store", async () => {
    // The regression this dep exists for (#434, #708): bundled installs serve
    // in place and are installed by default, so a handler scanning only the
    // git store answers `{apps:[]}` and 404s every seed POST.
    const codeAppsDir = await tempDir("demo-routes-code-");
    const bundledRoot = await tempDir("demo-routes-bundled-");
    await writeSeed(bundledRoot, "tasks");
    const handler = makeDemoRouteHandler(fakeVaults(), {
      bundledAppDirs: () =>
        new Map([["tasks", path.join(bundledRoot, "tasks")]]),
      codeAppsDir: () => codeAppsDir,
    });
    const base = await serve(handler);

    await expect(
      (await fetch(`${base}/centraid/_vault/demo`)).json()
    ).resolves.toStrictEqual({
      apps: [{ appId: "tasks", rows: 0, seedable: true }],
    });

    mocks.runHandler.mockResolvedValueOnce({ ok: true, logs: [] });
    const loaded = await fetch(`${base}/centraid/_vault/demo/tasks`, {
      method: "POST",
    });
    expect(loaded.status).toBe(200);
    // It ran the BUNDLED generator, not a code-store path that does not exist.
    expect(mocks.runHandler.mock.calls[0]?.[0]).toMatchObject({
      handlerFile: path.join(bundledRoot, "tasks", "seed.js"),
    });
  });

  test("decodes app ids and applies safe result, row, and error defaults", async () => {
    const codeAppsDir = await tempDir("demo-routes-defaults-");
    await writeSeed(codeAppsDir, "encoded app");
    const handler = makeDemoRouteHandler(fakeVaults(), {
      bundledAppDirs: () => new Map(),
      codeAppsDir: () => codeAppsDir,
    });
    const base = await serve(handler);

    mocks.runHandler.mockResolvedValueOnce({ ok: true, logs: [] });
    const loaded = await fetch(`${base}/centraid/_vault/demo/encoded%20app`, {
      method: "POST",
    });
    expect(loaded.status).toBe(200);
    await expect(loaded.json()).resolves.toStrictEqual({
      ok: true,
      result: null,
      rows: 0,
    });
    expect(mocks.runHandler.mock.calls[0]?.[0]).toMatchObject({
      app: { id: "encoded app" },
    });

    mocks.runHandler.mockResolvedValueOnce({ ok: false, logs: [] });
    const failed = await fetch(`${base}/centraid/_vault/demo/encoded%20app`, {
      method: "POST",
    });
    expect(failed.status).toBe(500);
    await expect(failed.json()).resolves.toStrictEqual({
      error: "seed generator failed",
      logs: [],
    });
  });
});

function fakeVaults(
  overrides: {
    demoStatus?: () => Array<{ appId: string; rows: number }>;
    demoBridgeFor?: (appId: string) => unknown;
    purgeDemo?: (appId?: string) => unknown;
  } = {}
): VaultRegistry {
  const plane = {
    demoStatus: overrides.demoStatus ?? (() => []),
    purgeDemo: overrides.purgeDemo ?? (() => ({ purged: 0 })),
  };
  return {
    current: () => plane,
    currentWorkspace: () => ({ appsDir: "/vault/apps" }),
    demoBridgeFor: overrides.demoBridgeFor ?? (() => ({})),
  } as unknown as VaultRegistry;
}

async function writeSeed(root: string, appId: string): Promise<void> {
  const directory = path.join(root, appId);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, "seed.js"),
    "export default async function seed() { return {}; }\n"
  );
}

async function serve(
  handler: ReturnType<typeof makeDemoRouteHandler>
): Promise<string> {
  const server = http.createServer((req, res) => {
    void handler(req, res)
      .then((handled) => {
        if (!handled) {
          res.writeHead(204);
          res.end();
        }
      })
      .catch((error: unknown) => {
        res.destroy(error instanceof Error ? error : new Error(String(error)));
      });
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}
