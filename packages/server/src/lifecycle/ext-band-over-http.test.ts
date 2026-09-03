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

function plainRows<T extends object>(rows: T[]): T[] {
  return rows.map((row) => ({ ...row }));
}

function manifest(ext?: unknown): string {
  return JSON.stringify({
    manifestVersion: 1,
    id: "gym",
    name: "Gym",
    version: "0.1.0",
    actions: [],
    queries: [],
    ...(ext ? { ext } : {}),
  });
}

const EXT_V1 = {
  tables: [
    {
      name: "workout",
      columns: [
        { name: "workout_id", type: "text", primaryKey: true },
        { name: "notes", type: "text" },
      ],
    },
  ],
};

describe("ext-band-over-http scenarios", () => {
  beforeEach(async () => {
    dataDir = await tempDir(`gw-ext-${crypto.randomUUID()}-`);
    handle = await serve({ paths: pathsUnder(dataDir) });
  });

  afterEach(async () => {
    await handle?.close().catch(() => undefined);
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  async function writeWorktreeFiles(
    sessionId: string,
    files: Record<string, string>
  ): Promise<void> {
    const appDir = await (
      await handle.appsStore()
    ).snapshotSessionAppDir(sessionId, "gym");
    await forEachSequentially(Object.entries(files), async ([rel, content]) => {
      const abs = path.join(appDir, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content);
    });
  }

  async function publish(
    sessionId: string,
    message: string
  ): Promise<Response> {
    return fetch(`${handle.url}/centraid/_apps/gym/publish`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, message }),
    });
  }

  function ownerSql(sql: string): Record<string, unknown>[] {
    return handle.vaults.current().sqlAsOwner(sql).rows;
  }

  test("publish applies the declared ext band to the vault; re-publish diffs", async () => {
    const store = await handle.appsStore();
    await store.openSession("s1");
    await writeWorktreeFiles("s1", {
      "app.json": manifest(EXT_V1),
      "index.html": "<!doctype html>gym",
    });
    const pub = await publish("s1", "v1 with ext band");
    expect(pub.status).toBe(201);
    const body = (await pub.json()) as { ext?: { created: string[] } };
    expect(body.ext?.created).toStrictEqual(["workout"]);

    expect(ownerSql("SELECT count(*) AS n FROM ext_gym_workout")[0]?.n).toBe(0);

    const extV2 = {
      tables: [
        {
          name: "workout",
          columns: [
            { name: "workout_id", type: "text", primaryKey: true },
            { name: "notes", type: "text" },
            { name: "reps", type: "integer" },
          ],
        },
        {
          name: "gear",
          columns: [{ name: "gear_id", type: "text", primaryKey: true }],
        },
      ],
    };
    await writeWorktreeFiles("s1", { "app.json": manifest(extV2) });
    const pub2 = await publish("s1", "v2 evolves the band");
    expect(pub2.status).toBe(201);
    const body2 = (await pub2.json()) as {
      ext?: { created: string[]; altered: string[]; dropped: string[] };
    };
    expect(body2.ext?.created).toStrictEqual(["gear"]);
    expect(body2.ext?.altered).toStrictEqual(["workout"]);
    expect(ownerSql("SELECT reps FROM ext_gym_workout LIMIT 0")).toStrictEqual(
      []
    );
  });

  test("a draft session branches a scratch band seeded from live; reset re-snapshots", async () => {
    const store = await handle.appsStore();
    await store.openSession("s1");
    await writeWorktreeFiles("s1", {
      "app.json": manifest(EXT_V1),
      "index.html": "<!doctype html>gym",
    });
    expect((await publish("s1", "v1")).status).toBe(201);
    const plane = handle.vaults.current();
    const live = await plane.invokeAsAssistant({
      command: "ext.gym.insert",
      input: { table: "workout", values: { notes: "live row" } },
      purpose: "dpv:ServiceProvision",
    });
    expect(live.status).toBe("executed");

    await store.openSession("draft1");
    await writeWorktreeFiles("draft1", {
      "app.json": manifest(EXT_V1),
    });
    const preview = await fetch(
      `${handle.url}/centraid/_draft/draft1/gym/_describe`,
      { headers: auth() }
    );
    expect(preview.status).toBe(200);
    expect(
      plainRows(ownerSql("SELECT notes FROM extdraft_gym_workout"))
    ).toStrictEqual([{ notes: "live row" }]);

    const draftWrite = await plane.invokeAsAssistant({
      command: "ext.gym.insert",
      input: {
        table: "workout",
        values: { notes: "draft only" },
        band: "draft",
      },
      purpose: "dpv:ServiceProvision",
    });
    expect(draftWrite.status).toBe("executed");
    expect(
      ownerSql("SELECT count(*) AS n FROM extdraft_gym_workout")[0]?.n
    ).toBe(2);
    expect(ownerSql("SELECT count(*) AS n FROM ext_gym_workout")[0]?.n).toBe(1);

    const reset = await fetch(`${handle.url}/centraid/_apps/gym/reset-data`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "draft1" }),
    });
    expect(reset.status).toBe(200);
    expect(
      ownerSql("SELECT count(*) AS n FROM extdraft_gym_workout")[0]?.n
    ).toBe(1);

    const close = await fetch(`${handle.url}/centraid/_apps/_sessions/draft1`, {
      method: "DELETE",
      headers: auth(),
    });
    expect(close.status).toBe(200);
    expect(() =>
      ownerSql("SELECT count(*) AS n FROM extdraft_gym_workout")
    ).toThrow(/no such table/u);
  });

  test("a spec the vault refuses aborts the publish; main never advances", async () => {
    const store = await handle.appsStore();
    await store.openSession("s1");
    await writeWorktreeFiles("s1", {
      "app.json": manifest({
        tables: [
          {
            name: "bad",
            columns: [{ name: "x", type: "text" }],
          },
        ],
      }),
      "index.html": "<!doctype html>gym",
    });
    const pub = await publish("s1", "bad band");
    expect(pub.status).toBe(400);
    const body = (await pub.json()) as { error: string; message: string };
    expect(body.error).toBe("invalid_ext_spec");
    expect(body.message).toMatch(/exactly one primaryKey/u);
    const versions = await store.listVersions("gym");
    expect(versions).toStrictEqual([]);
    expect(() => ownerSql("SELECT 1 FROM ext_gym_bad")).toThrow(
      /no such table/u
    );
  });

  test("purge-ext over HTTP drops the app ext band and its data", async () => {
    const store = await handle.appsStore();
    await store.openSession("s1");
    await writeWorktreeFiles("s1", {
      "app.json": manifest(EXT_V1),
      "index.html": "<!doctype html>gym",
    });
    expect((await publish("s1", "v1")).status).toBe(201);

    const plane = handle.vaults.current();
    expect(
      (
        await plane.invokeAsAssistant({
          command: "ext.gym.insert",
          input: { table: "workout", values: { notes: "reclaim me" } },
          purpose: "dpv:ServiceProvision",
        })
      ).status
    ).toBe("executed");
    expect(ownerSql("SELECT count(*) AS n FROM ext_gym_workout")[0]?.n).toBe(1);

    const purge = await fetch(
      `${handle.url}/centraid/_vault/apps/gym/purge-ext`,
      {
        method: "POST",
        headers: auth(),
      }
    );
    expect(purge.status).toBe(200);
    const body = (await purge.json()) as { purged: string[] };
    expect(body.purged).toStrictEqual(["workout"]);

    expect(() => ownerSql("SELECT 1 FROM ext_gym_workout")).toThrow(
      /no such table/u
    );
  });
});
